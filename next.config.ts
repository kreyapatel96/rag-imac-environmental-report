import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/ESM-heavy PDF packages must stay external to the server bundle.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "@huggingface/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
