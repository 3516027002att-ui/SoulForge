import { randomUUID } from 'node:crypto';
import type { SceneResourceIdentity, SceneSnapshotV2 } from '@soulforge/shared';

export interface SceneExportLease {
  exportSessionId: string;
  owner: string;
  workspaceId: string;
  sourceVersions: Record<string, string>;
  objectAllowlist: string[];
  assetAllowlist: string[];
  coordinateProfileHash: string;
  expiresAt: number;
  closed: boolean;
  sceneResourceIdentity: SceneResourceIdentity;
}

export class SceneExportLeaseStore {
  private readonly leases = new Map<string, SceneExportLease>();

  open(input: Omit<SceneExportLease, 'exportSessionId' | 'closed'>): SceneExportLease {
    if (!input.owner || !input.workspaceId || input.expiresAt <= Date.now()) throw new Error('SCENE_LEASE_INVALID');
    const lease: SceneExportLease = { ...input, exportSessionId: randomUUID(), closed: false, objectAllowlist: [...new Set(input.objectAllowlist)], assetAllowlist: [...new Set(input.assetAllowlist)], sourceVersions: { ...input.sourceVersions } };
    this.leases.set(lease.exportSessionId, lease);
    return structuredClone(lease);
  }

  registerSnapshot(snapshot: SceneSnapshotV2, owner: string): SceneExportLease {
    return this.open({
      owner,
      workspaceId: snapshot.workspaceId,
      sourceVersions: { [snapshot.sceneResourceIdentity.sourceUri]: snapshot.snapshotVersion },
      objectAllowlist: snapshot.objects.map((object) => object.objectHandle),
      assetAllowlist: snapshot.assetRefs.map((asset) => asset.assetHandle),
      coordinateProfileHash: snapshot.coordinateProfileHash,
      expiresAt: Date.now() + 10 * 60_000,
      sceneResourceIdentity: snapshot.sceneResourceIdentity
    });
  }

  get(exportSessionId: string): SceneExportLease | undefined {
    const lease = this.leases.get(exportSessionId);
    return lease ? structuredClone(lease) : undefined;
  }

  requireAuthorized(exportSessionId: string, owner: string, workspaceId: string): SceneExportLease {
    const lease = this.leases.get(exportSessionId);
    if (!lease || lease.closed || lease.owner !== owner || lease.workspaceId !== workspaceId) throw new Error('SCENE_LEASE_UNAUTHORIZED');
    if (lease.expiresAt <= Date.now()) {
      lease.closed = true;
      throw new Error('SCENE_LEASE_EXPIRED');
    }
    return structuredClone(lease);
  }

  close(exportSessionId: string, owner: string): void {
    const lease = this.leases.get(exportSessionId);
    if (!lease || lease.owner !== owner) throw new Error('SCENE_LEASE_UNAUTHORIZED');
    lease.closed = true;
  }
}
