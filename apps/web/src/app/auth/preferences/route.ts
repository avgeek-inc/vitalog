import { accountProxy } from "../../../lib/account-proxy";
export const PUT = (request: Request) =>
  accountProxy(request, "/auth/preferences");
