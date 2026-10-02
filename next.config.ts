import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Old page URLs (before the 2026-10-02 navigation cleanup) keep working for bookmarks and links.
  async redirects() {
    return [
      { source: "/bet-manager", destination: "/sessions/new", permanent: false },
      { source: "/placements", destination: "/bets", permanent: false },
      { source: "/config", destination: "/settings", permanent: false },
      { source: "/sessions", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
