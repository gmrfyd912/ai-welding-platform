import type { Express, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { textToSpeech } from "./replit_integrations/audio/client";

// `gemini-2.5-flash` is the most reliable Flash model that strictly honors
// `responseSchema` for structured JSON output. The Gemini 3.x preview models
// occasionally ignore the schema and return prose. Override via GEMINI_MODEL.
// Options: gemini-2.5-flash (default, stable), gemini-flash-latest (auto-newest),
// gemini-3-flash-preview, gemini-3.1-flash-lite-preview.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const SYSTEM_PROMPT = `[Role]
You are an expert Welding Instructor providing real-time coaching to a Korean trainee.
You are analyzing a single freshly captured frame from an Endoscope Camera attached to the Welding Torch (GTAW / TIG welding).

[Visual Tasks]
On EACH frame, evaluate the following:
1. Arc Length (too long / too short / OK)
2. Travel Speed inferred from bead width and ripple spacing (too fast / too slow / OK)
3. Torch Angle (work angle, travel angle)
4. Melt Pool size, shape and stability
5. Defects: spatter, undercut, overlap, porosity, lack of fusion

[Output Rules]
- ALWAYS respond as a SINGLE JSON object: { "severity": "ok"|"warn"|"danger", "message": "..." }
- The very first character of your reply MUST be "{" and the last MUST be "}". No preamble. No explanations. No markdown. No code fences. No "Here is".
- "message" MUST be Korean. MUST be a SHORT corrective command (5~12 단어, 마침표 1개).
- "severity":
  * "danger" — 즉시 멈추거나 심각한 결함이 보이는 경우 (예: 큰 기공, 심한 언더컷, 아크가 끊김, 위험)
  * "warn"   — 교정이 필요한 경우 (예: 속도 빠름, 아크 김, 토치 각도 어긋남, 비용접 화면)
  * "ok"     — 정상 용접 상태
- Provide commands (지시) or short observations (관찰). 예: "용접 속도를 줄이세요." / "아크 길이를 짧게." / "토치 각도 75도 유지." / "정상, 현재 속도 유지."

[Scene-Based Response When No Welding Visible]
If you do NOT see an active weld (no arc, no melt pool), do NOT keep repeating the same canned message. Instead, BRIEFLY DESCRIBE what you actually see and tell the user what to do. Examples (vary the wording each frame):
- 손이 보이면: "손이 보입니다. 용접 토치를 화면에 비추세요."
- 얼굴이 보이면: "얼굴이 감지됩니다. 카메라를 용접부로 향하세요."
- 어두우면: "화면이 어둡습니다. 조명을 켜거나 노출을 올리세요."
- 흐릿하면: "초점이 맞지 않습니다. 카메라를 안정시키세요."
- 천장/벽이 보이면: "용접 작업면이 보이지 않습니다. 카메라 각도를 조절하세요."
- 모재만 보이고 아크 없음: "모재가 보입니다. 아크를 점화하세요."
- 너무 가까움: "너무 가깝습니다. 거리를 두세요."
- 너무 멈: "용접 부위가 작게 보입니다. 가까이 다가가세요."
- 일반 사물(키보드, 책상 등): 그 사물 이름을 짧게 언급하고 카메라를 용접 작업면으로 옮기라고 하세요.
Always tailor the message to what is genuinely visible in THIS frame. NEVER output the exact same sentence two frames in a row unless the scene is identical.

- DO NOT include any text outside of the JSON object.`;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
}

export function registerCoachingRoutes(app: Express) {
  // Serve the live-coaching HTML from a same-origin HTTPS URL so the WebView
  // gets a secure context and `navigator.mediaDevices` becomes available
  // (browsers gate getUserMedia behind HTTPS / localhost).
  app.get("/coaching-live.html", (_req: Request, res: Response) => {
    try {
      const p = path.resolve(
        process.cwd(),
        "server",
        "templates",
        "coaching-live.html",
      );
      const html = fs.readFileSync(p, "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      // Allow camera/mic access in this document and any nested iframes
      res.setHeader("Permissions-Policy", "camera=(self), microphone=(self)");
      res.status(200).send(html);
    } catch (e: any) {
      res.status(500).send("template load failed: " + (e?.message || e));
    }
  });

  // 서버에서 OpenAI TTS 로 한국어 음성 생성. WebView 의 speechSynthesis 가 iOS 에서
  // 너무 불안정해서, MP3 를 직접 만들어 <audio> 태그로 재생하는 방식이 가장 안정적입니다.
  // GET 형태로 만들어 <audio src="..."> 로 바로 사용할 수 있게 합니다.
  app.get("/api/coaching/tts", async (req: Request, res: Response) => {
    const text = String(req.query.text || "").trim();
    const voice = String(req.query.voice || "nova");
    if (!text) {
      return res.status(400).send("text query required");
    }
    if (text.length > 200) {
      return res.status(400).send("text too long");
    }
    try {
      const buf = await textToSpeech(text, voice as any, "mp3");
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Content-Length", String(buf.length));
      res.status(200).send(buf);
    } catch (e: any) {
      console.error("[coaching] tts error:", e?.message || e);
      res.status(502).send("tts failed: " + (e?.message || "unknown"));
    }
  });

  app.post("/api/coaching/analyze", async (req: Request, res: Response) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        severity: "warn",
        message: "GEMINI_API_KEY 미설정",
      });
    }

    const { imageBase64, mimeType } = req.body ?? {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "imageBase64 (string) is required" });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");
    const mt = typeof mimeType === "string" && mimeType ? mimeType : "image/jpeg";

    const url = `${API_BASE}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: "이 프레임을 분석하고 한국어 코칭 멘트를 JSON으로만 응답하세요." },
            { inline_data: { mime_type: mt, data: cleanBase64 } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            severity: { type: "STRING", enum: ["ok", "warn", "danger"] },
            message: { type: "STRING" },
          },
          required: ["severity", "message"],
        },
        // gemini-2.5-flash 는 기본적으로 내부 thinking 토큰을 소비하는데, 이 토큰이
        // maxOutputTokens 에 합산돼서 실제 응답이 잘립니다. thinkingBudget=0 으로
        // thinking 을 비활성화하면 모든 토큰이 실제 출력으로 사용됩니다.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 256,
        temperature: 0.2,
      },
    };

    try {
      const t0 = Date.now();
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const elapsed = Date.now() - t0;
      const data = (await r.json()) as GeminiResponse;

      if (!r.ok || data.error) {
        const msg = data.error?.message || `Gemini API ${r.status}`;
        console.warn("[coaching] gemini error:", msg);
        return res.status(502).json({
          severity: "warn",
          message: "AI 응답 오류",
          error: msg,
        });
      }

      if (data.promptFeedback?.blockReason) {
        return res.json({
          severity: "warn",
          message: "프레임 분석 차단됨",
        });
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) {
        return res.json({ severity: "warn", message: "분석 결과 없음" });
      }

      // Robust JSON extraction — strip markdown fences and any preamble like
      // "Here is the JSON requested:" that some Gemini variants prepend.
      let parsed: { severity?: string; message?: string } | null = null;
      const tryParse = (s: string) => {
        try {
          const v = JSON.parse(s);
          if (v && typeof v === "object") {
            parsed = v as { severity?: string; message?: string };
            return true;
          }
        } catch {}
        return false;
      };

      // Attempt 1: raw text
      if (!tryParse(text)) {
        // Attempt 2: strip ```json ... ``` fences
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenced && tryParse(fenced[1].trim())) {
          // ok
        } else {
          // Attempt 3: extract first {...} block (greedy to last })
          const start = text.indexOf("{");
          const end = text.lastIndexOf("}");
          if (start >= 0 && end > start) {
            tryParse(text.slice(start, end + 1));
          }
        }
      }

      if (!parsed) {
        console.error("[coaching] PARSE FAIL. finishReason=",
          data.candidates?.[0]?.finishReason,
          "rawText=", JSON.stringify(text));
        return res.json({
          severity: "warn",
          message: "응답 형식 오류, 재시도 중",
          raw: text.slice(0, 200),
          finishReason: data.candidates?.[0]?.finishReason,
        });
      }

      const severity = (["ok", "warn", "danger"].includes(parsed.severity ?? "")
        ? parsed.severity
        : "warn") as "ok" | "warn" | "danger";
      const message = (parsed.message || "").trim().slice(0, 80) || "분석중";

      return res.json({ severity, message, elapsedMs: elapsed, model: MODEL });
    } catch (e) {
      const err = e as Error;
      console.warn("[coaching] fetch error:", err.message);
      return res.status(502).json({
        severity: "warn",
        message: "네트워크 오류",
        error: err.message,
      });
    }
  });
}
