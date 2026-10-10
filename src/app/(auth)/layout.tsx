import { BrandMark } from "@/components/BrandMark";

/** Shell for the public auth forms (/login, /signup). Routing and behaviour are unchanged. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="public-shell auth-shell">
      <BrandMark />
      <div className="auth-card">{children}</div>
    </main>
  );
}
