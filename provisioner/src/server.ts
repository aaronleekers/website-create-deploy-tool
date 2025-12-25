import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import { Vercel } from '@vercel/sdk';

// Node 18+ has global fetch via undici
const app = express();
app.use(express.json({ limit: '1mb' }));

const {
  PORT = '3007',
  SANITY_MANAGEMENT_TOKEN,
  SANITY_API_VERSION = 'v2021-06-07',
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_TEAM_SLUG,
  GIT_PROVIDER = 'github',
  GIT_REPO,
  GIT_REF = 'main',
} = process.env;

if (!SANITY_MANAGEMENT_TOKEN) throw new Error('Missing SANITY_MANAGEMENT_TOKEN');
if (!VERCEL_TOKEN) throw new Error('Missing VERCEL_TOKEN');
if (!GIT_REPO) throw new Error('Missing GIT_REPO');

const vercel = new Vercel({ bearerToken: VERCEL_TOKEN });

/**
 * Sanity Management API helpers
 * Base URL per docs: https://api.sanity.io/{apiVersion} :contentReference[oaicite:5]{index=5}
 */
const sanityBase = `https://api.sanity.io/${SANITY_API_VERSION}`;

async function sanityRequest<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${sanityBase}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${SANITY_MANAGEMENT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    body: init.json ? JSON.stringify(init.json) : (init.body ?? null),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sanity ${res.status} ${res.statusText}: ${text}`);
  }

  return (await res.json()) as T;
}

type SanityProject = {
  id: string;
  displayName: string;
  studioHost?: string | null;
};

async function createSanityProject(displayName: string): Promise<SanityProject> {
  // POST /projects :contentReference[oaicite:6]{index=6}
  return sanityRequest<SanityProject>('/projects', {
    method: 'POST',
    json: { displayName },
  });
}

async function createSanityDataset(projectId: string, dataset: string) {
  // PUT /projects/{projectId}/datasets/{name} :contentReference[oaicite:7]{index=7}
  return sanityRequest<{ name: string; aclMode: string }>(
    `/projects/${projectId}/datasets/${dataset}`,
    {
      method: 'PUT',
      json: { aclMode: 'public' }, // change to 'private' if you want
    },
  );
}

async function createSanityToken(projectId: string, label: string) {
  // POST /projects/{projectId}/tokens returns a "key" (the actual token) :contentReference[oaicite:8]{index=8}
  // roles shape is documented as an array of role objects; for most setups you want "editor" or custom roles.
  return sanityRequest<{
    id: string;
    label: string;
    key: string;
    roles: Array<{ name: string; title?: string }>;
  }>(`/projects/${projectId}/tokens`, {
    method: 'POST',
    json: {
      label,
      // This is the part you may tailor. Many accounts use "editor" role names.
      roles: [{ name: 'editor' }],
    },
  });
}

/**
 * Vercel helpers
 */
async function createVercelProject(projectName: string) {
  // POST /v11/projects via SDK :contentReference[oaicite:9]{index=9}
  return vercel.projects.createProject({
    teamId: VERCEL_TEAM_ID,
    slug: VERCEL_TEAM_SLUG,
    requestBody: {
      name: projectName,
      framework: 'nextjs',
      gitRepository: {
        type: GIT_PROVIDER as 'github' | 'gitlab' | 'bitbucket',
        repo: GIT_REPO!,
        // If you need monorepo: rootDirectory: "apps/site"
      },
    },
  });
}

async function upsertEnvVars(projectIdOrName: string, envs: Array<{
  key: string;
  value: string;
  type: 'plain' | 'encrypted';
  target: Array<'production' | 'preview' | 'development'>;
}>) {
  // createProjectEnv (upsert) :contentReference[oaicite:10]{index=10}
  return vercel.projects.createProjectEnv({
    idOrName: projectIdOrName,
    upsert: 'true',
    requestBody: envs,
  });
}

/**
 * Provision endpoint
 */
const ProvisionReq = z.object({
  siteName: z.string().min(3).max(60).regex(/^[a-z0-9-]+$/i, 'use a sluggy name'),
  sanityDisplayName: z.string().min(3).max(80).optional(),
  dataset: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/i).default('production'),
});

app.post('/provision', async (req, res) => {
  try {
    const input = ProvisionReq.parse(req.body);

    // 1) Sanity: project + dataset + token
    const sanityProject = await createSanityProject(
      input.sanityDisplayName ?? input.siteName,
    );

    const dataset = input.dataset;
    await createSanityDataset(sanityProject.id, dataset);

    const sanityToken = await createSanityToken(
      sanityProject.id,
      `${input.siteName}-server`,
    );

    // 2) Vercel: project from template repo
    const vercelProject = await createVercelProject(input.siteName);

    // 3) Vercel envs: public + server-only
    // Public is fine for projectId/dataset. Token should be encrypted + NOT NEXT_PUBLIC.
    await upsertEnvVars(vercelProject.id, [
      {
        key: 'NEXT_PUBLIC_SANITY_PROJECT_ID',
        value: sanityProject.id,
        type: 'plain',
        target: ['production', 'preview', 'development'],
      },
      {
        key: 'NEXT_PUBLIC_SANITY_DATASET',
        value: dataset,
        type: 'plain',
        target: ['production', 'preview', 'development'],
      },
      {
        key: 'SANITY_API_TOKEN',
        value: sanityToken.key,
        type: 'encrypted',
        target: ['production', 'preview'],
      },
    ]);

    // 4) Deploy trigger
    // If your repo is already connected and Vercel imported it, Vercel will deploy on push.
    // If you want “deploy NOW”, the cleanest way is a Deploy Hook per project.
    // This server returns enough info for you to create one or call deployments.createDeployment.
    // Deploy hooks are documented here: :contentReference[oaicite:11]{index=11}

    res.json({
      ok: true,
      sanity: {
        projectId: sanityProject.id,
        dataset,
        tokenLabel: sanityToken.label,
        // NOTE: do NOT log/return token.key in real life unless you enjoy security incidents
      },
      vercel: {
        projectId: vercelProject.id,
        name: vercelProject.name,
      },
      notes: [
        'Vercel env vars set. Token stored as encrypted env.',
        'For an immediate deploy, create & call a Deploy Hook, or trigger a deployment via API.',
      ],
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) });
  }
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(Number(PORT), () => {
  console.log(`Provisioner listening on http://localhost:${PORT}`);
});
