import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { CompatibilityResolveResult } from '../../../shared/compatibility-requirement';
import type { IpcContext } from '../ipc-context';

export function registerCompatibilityHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.COMPATIBILITY_LIST, (_event, projectId: string) => (
    context.compatibilityRequirements.list(projectId)
  ));
  ipcMain.handle(IPC.COMPATIBILITY_GET, (_event, projectId: string, requirementId: string) => (
    context.compatibilityRequirements.get(projectId, requirementId)
  ));
  ipcMain.handle(
    IPC.COMPATIBILITY_RESOLVE,
    async (_event, projectId: string, requirementId: string): Promise<CompatibilityResolveResult> => {
      const requirement = context.compatibilityRequirements.get(projectId, requirementId);
      const project = context.projectRepo.getById(projectId);
      if (requirement === null || !project) return { kind: 'not-found' };
      context.configManager.acknowledgeProjectCompatibility(project.path, requirement.acknowledgementId);
      return context.compatibilityRequirements.resolve(projectId, requirementId);
    },
  );
}
