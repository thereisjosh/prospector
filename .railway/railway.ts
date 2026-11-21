import { defineRailway, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const webVolume = volume("web-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 50000 });
  const web = service("web", {
    // From railway.json (Config as Code, retired 2026-12-01): Nixpacks build, npm start, health check.
    build: { buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "npm start",
    healthcheck: "/api/health",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    volumeMounts: { "/data": webVolume },
  });

  return project("prospector", {
    variables: { managed: false },
    resources: [web, webVolume],
  });
});
