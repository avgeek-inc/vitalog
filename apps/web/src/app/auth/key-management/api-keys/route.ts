import { keyManagementProxy } from "../../../../lib/key-management";
export const GET = (request: Request) =>
  keyManagementProxy(request, "api-keys");
export const POST = (request: Request) =>
  keyManagementProxy(request, "api-keys");
export const DELETE = (request: Request) =>
  keyManagementProxy(request, "api-keys");
