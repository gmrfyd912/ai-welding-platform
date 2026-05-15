// Google Drive integration using googleapis OAuth2
// Credentials stored as GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

import { google } from "googleapis";
import { Readable } from "stream";

const FOLDER_NAME = "HHI_Welding_Photos";
let cachedFolderId: string | null = null;

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function getDriveClient() {
  return google.drive({ version: "v3", auth: getOAuth2Client() });
}

async function getOrCreateFolder(): Promise<string> {
  if (cachedFolderId) return cachedFolderId;

  const drive = getDriveClient();

  // 기존 폴더 검색
  const searchRes = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
  });

  if (searchRes.data.files && searchRes.data.files.length > 0) {
    cachedFolderId = searchRes.data.files[0].id!;
    console.log("📁 드라이브 폴더 재사용:", cachedFolderId);
    return cachedFolderId;
  }

  // 폴더 생성
  const createRes = await drive.files.create({
    requestBody: {
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  cachedFolderId = createRes.data.id!;
  console.log("📁 드라이브 폴더 생성:", cachedFolderId);
  return cachedFolderId;
}

async function makeFilePublic(drive: any, fileId: string): Promise<void> {
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });
}

export async function uploadBase64ToGoogleDrive(
  base64: string,
  fileName: string
): Promise<string> {
  const drive = getDriveClient();
  const folderId = await getOrCreateFolder();

  // base64 → Buffer → Readable stream
  const buffer = Buffer.from(base64, "base64");
  const stream = Readable.from(buffer);

  const uploadRes = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: "image/jpeg",
      body: stream,
    },
    fields: "id",
  });

  const fileId = uploadRes.data.id;
  if (!fileId) throw new Error("Google Drive 파일 업로드 실패: fileId 없음");

  await makeFilePublic(drive, fileId);

  // 앱에서 이미지로 바로 표시 가능한 URL
  const url = `https://drive.google.com/uc?export=view&id=${fileId}`;
  console.log(`✅ 드라이브 업로드 완료: ${fileName} → ${url}`);
  return url;
}
