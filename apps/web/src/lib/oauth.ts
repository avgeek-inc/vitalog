export function authorizationCallback(
  issuer: string,
  callback: string,
  result: string,
  action: "allow" | "deny",
) {
  const redirect = new URL(result);
  const target = new URL(callback);
  if (
    redirect.hash ||
    redirect.searchParams.getAll("iss").length !== 1 ||
    redirect.searchParams.get("iss") !== issuer ||
    redirect.searchParams.getAll("state").length > 1 ||
    redirect.searchParams.has("access_token")
  )
    throw new Error("Invalid authorization response");
  if (
    action === "allow"
      ? redirect.searchParams.getAll("code").length !== 1 ||
        !/^voc_[A-Za-z0-9_-]{43}$/.test(
          redirect.searchParams.get("code") ?? "",
        ) ||
        redirect.searchParams.has("error")
      : redirect.searchParams.getAll("error").length !== 1 ||
        redirect.searchParams.get("error") !== "access_denied" ||
        redirect.searchParams.has("code")
  )
    throw new Error("Invalid authorization response");
  const base = new URL(redirect);
  for (const key of ["code", "state", "iss", "error", "error_description"])
    base.searchParams.delete(key);
  target.search = target.searchParams.toString();
  if (base.href !== target.href) throw new Error("Invalid callback");
  return redirect.href;
}
