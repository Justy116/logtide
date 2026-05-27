import {
  createTestUser,
  createTestOrganization,
  createTestProject,
  createTestApiKey,
} from '../helpers/index.js';

export interface IsolatedProject {
  id: string;
  apiKey: { id: string; key: string };
}

export interface IsolatedOrg {
  id: string;
  ownerUserId: string;
  projects: IsolatedProject[];
}

export interface IsolatedTenants {
  orgA: IsolatedOrg;
  orgB: IsolatedOrg;
}

async function buildOrg(projectCount: number): Promise<IsolatedOrg> {
  const owner = await createTestUser();
  const org = await createTestOrganization({ ownerId: owner.id });
  const projects: IsolatedProject[] = [];
  for (let i = 0; i < projectCount; i++) {
    const project = await createTestProject({ organizationId: org.id, userId: owner.id });
    const apiKey = await createTestApiKey({ projectId: project.id });
    projects.push({ id: project.id, apiKey: { id: apiKey.id, key: apiKey.plainKey } });
  }
  return { id: org.id, ownerUserId: owner.id, projects };
}

/** org A has projects A1, A2 (for cross-project checks); org B has project B1. */
export async function createIsolatedTenants(): Promise<IsolatedTenants> {
  const orgA = await buildOrg(2);
  const orgB = await buildOrg(1);
  return { orgA, orgB };
}
