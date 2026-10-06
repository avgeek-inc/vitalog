import Link from "next/link";
export default function NotFound() {
  return (
    <div className="not-found">
      <h1 className="page-title">Page not found</h1>
      <Link href="/daily">Return to Daily</Link>
    </div>
  );
}
