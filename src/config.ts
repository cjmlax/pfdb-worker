import dotenv from 'dotenv';

dotenv.config();

function opt(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

// All runtime configuration in one place. Required-at-use secrets (Teable token)
// are read lazily so the worker can still boot and serve /healthz with an
// incomplete config. Admin auth is handled entirely by the SPA bearer token
// (see userAuth below) — there is no cookie/session login.
export const config = {
  port: Number(opt('PORT', '8090')),
  host: opt('HOST', '0.0.0.0'),
  // Public origin of the site; the worker is served under it at /api/*. Used to
  // build the account-linking callback URL and the redirect back to /account.
  siteUrl: opt('SITE_URL', 'https://pfdatabase.com').replace(/\/$/, ''),
  allowedOrigin: opt('ALLOWED_ORIGIN', '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Salt for hashing submitter IPs (abuse tracking). Falls back to the old
  // COOKIE_SECRET so existing deployments keep producing the same hashes.
  ipHashSecret: opt('IP_HASH_SECRET', opt('COOKIE_SECRET', 'change-me-ip-salt')),

  // Postgres, reached through the node's HAProxy (port 5000), which always
  // points at the current primary.
  databaseUrl: opt('DATABASE_URL', ''),

  // Verification config for id_tokens issued to the public SPA (the Zitadel
  // pfdb-web app). These are public values, so the defaults are safe to ship.
  userAuth: {
    issuer:     opt('USER_OIDC_ISSUER', 'https://auth.pfdatabase.com'),
    clientId:   opt('USER_OIDC_CLIENT_ID', '394712072014790658'),
    // Zitadel's project roles claim: an object keyed by role name.
    rolesClaim: opt('USER_OIDC_ROLES_CLAIM', 'urn:zitadel:iam:org:project:roles'),
    // Role that grants SPA admin powers.
    adminRole:  opt('USER_OIDC_ADMIN_ROLE', 'admins'),
    // Role for moderators — drives the auto-managed Mod badge (see
    // users.syncGroupBadge) and gates the mod tools (see userAuth.requireUserMod).
    modRole:    opt('USER_OIDC_MOD_ROLE', 'mods'),
  },

  // Zitadel's API, reached inside the compose network. Zitadel picks its
  // instance from the Host header, so every call sends publicHost (see zitadel.ts).
  // The service token belongs to the pfdb-worker machine user (Org User Manager),
  // used to read and add a user's identity provider links.
  zitadel: {
    apiUrl:       opt('ZITADEL_API_URL', 'http://zitadel:8080').replace(/\/$/, ''),
    publicHost:   opt('ZITADEL_PUBLIC_HOST', 'auth.pfdatabase.com'),
    serviceToken: opt('ZITADEL_SERVICE_TOKEN', ''),
    // Identity provider id → the platform key the site uses for it.
    idps: Object.fromEntries(
      (['discord', 'twitch', 'google'] as const)
        .map((key) => [opt(`ZITADEL_IDP_${key.toUpperCase()}`, ''), key])
        .filter(([id]) => id),
    ) as Record<string, string>,
    // Signing key of the Zitadel Actions v2 target that points at
    // /api/zitadel/actions/idp-intent (see routes/zitadelActions.ts).
    actionSigningKey: opt('ZITADEL_ACTION_SIGNING_KEY', ''),
  },

  // Garage bucket for submission screenshots, reached over the mesh.
  s3: {
    endpoint:        opt('S3_ENDPOINT', ''),
    region:          opt('S3_REGION', 'garage'),
    bucket:          opt('S3_BUCKET', 'pfdb-worker'),
    accessKeyId:     opt('S3_ACCESS_KEY_ID', ''),
    secretAccessKey: opt('S3_SECRET_ACCESS_KEY', ''),
  },

  teable: {
    baseUrl: opt('TEABLE_BASE_URL', 'https://teable.pfdatabase.com').replace(/\/$/, ''),
    token: opt('TEABLE_TOKEN', ''),
    // Table IDs are resolved by name at runtime (see resolveTableId) and cached,
    // so individual table IDs no longer need to be configured — only the base.
    baseId: opt('TEABLE_BASE_ID', 'bseylZk8mJzj9xeoAHy'),
  },

  upload: {
    maxBytes: Number(opt('UPLOAD_MAX_BYTES', String(5 * 1024 * 1024))),
  },

  image: {
    quality: Number(opt('IMAGE_QUALITY', '80')),
    // Width auto-cropped and admin-cropped screenshots are normalized to
    // (never upscaled) — legible on the site without storing phone-native sizes.
    screenshotWidth: Number(opt('IMAGE_SCREENSHOT_WIDTH', '800')),
  },

  export: {
    hashRefreshCron: opt('EXPORT_HASH_CRON', '0 0 * * *'),
  },

  changelog: {
    // Version poller writes new iOS/Android versions (from Apptopia) to the Teable "Changelog" table.
    pollCron: opt('CHANGELOG_POLL_CRON', '0 6 * * *'), // daily at 6 AM
  },

  weeklySets: {
    pollCron: opt('WEEKLY_SETS_POLL_CRON', '2 14 * * 1'), // Mondays at 2:02 PM ET
  },

  frogStats: {
    // Home page frog count + highest value, cached in memory and recomputed on this schedule.
    refreshCron: opt('FROG_STATS_REFRESH_CRON', '0 5 * * *'), // daily at 5 AM
  },

  notify: {
    webhookUrls: opt('WEBHOOK_URL', '').split(',').map((s) => s.trim()).filter(Boolean),
    adminUrl: opt('ADMIN_URL', opt('SITE_URL', 'https://pfdatabase.com')).replace(/\/$/, ''),
    on: {
      submit:  opt('WEBHOOK_ON_SUBMIT',  'true') !== 'false',
      approve: opt('WEBHOOK_ON_APPROVE', 'true') !== 'false',
      reject:  opt('WEBHOOK_ON_REJECT',  'true') !== 'false',
      pollerFailure: opt('WEBHOOK_ON_POLLER_FAIL', 'true') !== 'false',
    },
  },
};
