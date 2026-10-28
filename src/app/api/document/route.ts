import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Active document status. Reads the local manifest, then checks Qdrant still holds the vectors. */
export async function GET() {
  try {
    const { storage, rag, uploadLock } = getServices();
    const manifest = await storage.readManifest();
    if (!manifest) return NextResponse.json({ document: null, busy: uploadLock.isLocked });
    let vectorStatus: "ok" | "missing" | "unreachable" = "ok";
    let vectorCount: number | null = null;
    try {
      vectorCount = await rag.store.countDoc(manifest.docId);
      if (vectorCount !== manifest.stats.chunks) vectorStatus = "missing";
    } catch {
      vectorStatus = "unreachable";
    }
    return NextResponse.json({ document: manifest, vectorStatus, vectorCount, busy: uploadLock.isLocked });
  } catch (e) {
    return errorResponse(e);
  }
}
