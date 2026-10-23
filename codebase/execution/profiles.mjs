export const executionProfiles = Object.freeze({
  local: { affected: false, checks: ["check"], tasks: [] },
  affected: { affected: true, checks: ["check"], tasks: ["build", "test"] },
  "pull-request": { affected: true, checks: ["check", "scan"], tasks: ["build", "test"] },
  main: { affected: false, checks: ["check", "scan"], tasks: ["build", "test"] },
  release: { affected: false, checks: ["check", "scan"], tasks: ["build", "test", "artifact"] }
});

export const getExecutionProfile = (name) => {
  const profile = executionProfiles[name];
  if (!profile) throw new Error(`Unknown execution profile: ${name}`);
  return { name, ...profile };
};
