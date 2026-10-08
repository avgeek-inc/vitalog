import { NextResponse } from "next/server";
import { keyManagementProxy } from "../../../../../lib/key-management";
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return NextResponse.json({}, { status: 422 });
  return keyManagementProxy(request, "api-keys/" + id);
}
