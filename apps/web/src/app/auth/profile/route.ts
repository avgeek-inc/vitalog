import { accountProxy } from "../../../lib/account-proxy";
export const PATCH = (request: Request) =>
  accountProxy(request, "/auth/profile");
