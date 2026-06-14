import React, {
  createContext,
  useContext,
  useState,
  useMemo,
  ReactNode,
} from "react";

export type AppRole = "education" | "field";

interface RoleContextValue {
  userRole: AppRole | null;
  setUserRole: (role: AppRole) => void;
  clearRole: () => void;
}

const RoleContext = createContext<RoleContextValue | null>(null);

export function RoleProvider({ children }: { children: ReactNode }) {
  const [userRole, setUserRoleState] = useState<AppRole | null>(null);

  const value = useMemo(
    () => ({
      userRole,
      setUserRole: (role: AppRole) => setUserRoleState(role),
      clearRole: () => setUserRoleState(null),
    }),
    [userRole]
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
