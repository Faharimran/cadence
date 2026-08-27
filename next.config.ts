import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The public API is versioned in the URL but lives under app/api/v1/*. Route
  // handlers are uncached by default in Next 16, which is what we want for every
  // endpoint here — availability and bookings must never be served stale.
  serverExternalPackages: ["@prisma/client", "bullmq", "ioredis"],
};

export default nextConfig;
