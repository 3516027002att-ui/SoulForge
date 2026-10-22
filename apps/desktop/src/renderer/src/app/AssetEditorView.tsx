import type { ReactElement } from 'react';
import { classifyWorkspaceOpen } from '@soulforge/shared';
import { GparamWorkbench } from '../workbench/GparamWorkbench.js';
import { TpfWorkbenchPanel } from '../editors/TpfWorkbenchPanel.js';
import { MaterialWorkbenchPanel } from '../editors/MaterialWorkbenchPanel.js';
import { VfxWorkbenchPanel } from '../editors/VfxWorkbenchPanel.js';
import { TaeWorkbenchPanel } from '../editors/TaeWorkbenchPanel.js';
import { EsdWorkbenchPanel } from '../editors/EsdWorkbenchPanel.js';
import { FlverWorkbenchPanel } from '../editors/FlverWorkbenchPanel.js';
import { domainLabel } from '../navigation/domainNavigation.js';
import type { NavigationController } from './useNavigationController.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import type { EditorProjection } from './useEditorProjection.js';

export interface AssetEditorViewProps extends Pick<EditorProjection,
  'activeEditor' | 'isMaterialFile' | 'isVfxFile' | 'gparamBanks' | 'textureContainers' | 'materialFiles'
  | 'vfxFiles' | 'paramWorkbenchFile' | 'showTextWorkbench' | 'showEventWorkbench'>,
  Pick<NavigationController, 'activeDomain' | 'domainLibraries'> {
  selectedFile: ResourceDocumentController['selectedFile'];
  document: Pick<ResourceDocumentController,
    'taeData' | 'esdData' | 'flverData' | 'applyFlverMaterialSlotSetAndReload'>;
}

/** Existing asset panels and empty fallbacks, with their original layout, keys and props. */
export function AssetEditorView(props: AssetEditorViewProps): ReactElement {
  const { activeEditor, activeDomain, selectedFile, isMaterialFile, isVfxFile, gparamBanks, textureContainers,
    materialFiles, vfxFiles, paramWorkbenchFile, showTextWorkbench, showEventWorkbench, domainLibraries } = props;
  const { taeData, esdData, flverData, applyFlverMaterialSlotSetAndReload } = props.document;
  // The three `as never` casts below are the existing App legacy Record<string, unknown>
  // data bridge. This extraction preserves that boundary; it does not validate native DTOs.
  return <>
          {activeEditor === 'gparam' && (
            <GparamWorkbench
              key={`gparam-wb:${selectedFile?.sourceUri ?? 'none'}`}
              banks={gparamBanks}
              {...(selectedFile?.sourceUri ? { initialUri: selectedFile.sourceUri } : {})}
            />
          )}
          {activeDomain === 'gparam' && activeEditor === 'empty' && gparamBanks.length > 0 && (
            <GparamWorkbench
              key={`gparam-wb:${gparamBanks.map((b) => b.sourceUri).join(',')}`}
              banks={gparamBanks}
            />
          )}
          {activeDomain === 'gparam' && activeEditor === 'empty' && gparamBanks.length === 0 && (
            <section className="domain-placeholder" data-testid="gparam-placeholder" aria-label="GPARAM 工作域">
              <span className="domain-placeholder__eyebrow">GPARAM</span>
              <h2>GPARAM 工作台</h2>
              <p>工作区中没有 GPARAM 文件。挂载包含 drawparam 的 Mod 工作区后这里会列出所有 bank。</p>
            </section>
          )}
          {activeDomain === 'texture' && activeEditor === 'empty' && textureContainers.length > 0 && (
            <TpfWorkbenchPanel
              key={`tpf-wb:${textureContainers.map((c) => c.sourceUri).join(',')}`}
              containers={textureContainers}
            />
          )}
          {activeDomain === 'texture' && activeEditor === 'empty' && textureContainers.length === 0 && (
            <section className="domain-placeholder" data-testid="texture-placeholder" aria-label="纹理工作域">
              <span className="domain-placeholder__eyebrow">TEXTURE</span>
              <h2>Texture 工作台</h2>
              <p>工作区中没有 TPF 文件。挂载包含纹理包的 Mod 工作区后这里会列出所有容器。</p>
            </section>
          )}
          {activeDomain === 'vfx' && activeEditor === 'empty' && vfxFiles.length > 0 && (
            <VfxWorkbenchPanel
              key={`vfx-wb:${vfxFiles.map((f) => f.sourceUri).join(',')}`}
              files={vfxFiles}
            />
          )}
          {activeDomain === 'vfx' && activeEditor === 'empty' && vfxFiles.length === 0 && (
            <section className="domain-placeholder" data-testid="vfx-placeholder" aria-label="VFX 工作域">
              <span className="domain-placeholder__eyebrow">VFX</span>
              <h2>VFX 工作台</h2>
              <p>工作区中没有 FXR 文件。挂载包含特效文件（.fxr）的 Mod 工作区后这里会列出所有特效条目。</p>
            </section>
          )}
          {activeDomain === 'material' && activeEditor === 'empty' && materialFiles.length > 0 && (
            <MaterialWorkbenchPanel
              key={`mtd-wb:${materialFiles.map((file) => file.sourceUri).join(',')}`}
              files={materialFiles}
            />
          )}
          {activeDomain === 'material' && activeEditor === 'empty' && materialFiles.length === 0 && (
            <section className="domain-placeholder" data-testid="material-placeholder" aria-label="材质工作域">
              <span className="domain-placeholder__eyebrow">MATERIAL</span>
              <h2>Material 工作台</h2>
              <p>工作区中没有 MTD 文件。挂载包含材质定义的 Mod 工作区后这里会列出所有文件。</p>
            </section>
          )}
          {activeEditor === 'empty' && activeDomain !== 'gparam' && activeDomain !== 'texture'
            && activeDomain !== 'vfx' && activeDomain !== 'material'
            && !paramWorkbenchFile && !showTextWorkbench && !showEventWorkbench && (
            activeDomain === 'files'
              ? <p className="muted">在左侧选择一个文件开始编辑。</p>
            : <section className="domain-placeholder" data-testid="domain-editor-placeholder" aria-label={`${domainLabel(activeDomain)} 工作域`}>
                <span className="domain-placeholder__eyebrow">DOMAIN / {domainLabel(activeDomain)}</span>
                <h2>从左侧打开一个文件</h2>
                <p>
                  {domainLibraries.length > 0
                    ? '从左侧选择已打开的资源，或按 Ctrl K 搜索。'
                    : '从左侧选择一个文件开始编辑，可到「文件」领域按路径浏览。'}
                </p>
              </section>
          )}
          {activeEditor === 'tae' && selectedFile && (
            <TaeWorkbenchPanel resourceUri={selectedFile.sourceUri} data={taeData as never} />
          )}
          {activeEditor === 'esd' && selectedFile && (
            <EsdWorkbenchPanel resourceUri={selectedFile.sourceUri} data={esdData as never} />
          )}
          {activeEditor === 'flver' && selectedFile && (
            <FlverWorkbenchPanel
              key={`flver-wb:${selectedFile?.sourceUri ?? 'none'}:${flverData !== null}`}
              resourceUri={selectedFile.sourceUri}
              data={flverData as never}
              onMaterialSlotSet={(input) => { void applyFlverMaterialSlotSetAndReload(input); }}
            />
          )}
          {activeEditor === 'tpf' && (
            <TpfWorkbenchPanel
              key={`tpf-wb:${selectedFile?.sourceUri ?? 'none'}`}
              containers={textureContainers}
              {...(selectedFile?.sourceUri ? { initialUri: selectedFile.sourceUri } : {})}
            />
          )}
          {activeEditor === 'vfx' && selectedFile && (
            <VfxWorkbenchPanel
              key={`vfx-wb:${selectedFile.sourceUri}`}
              files={vfxFiles}
              initialUri={selectedFile.sourceUri}
            />
          )}
          {activeEditor === 'binary' && isMaterialFile && selectedFile && (
            <MaterialWorkbenchPanel
              key={`mtd-wb:${selectedFile.sourceUri}`}
              files={materialFiles}
              initialUri={selectedFile.sourceUri}
            />
          )}
          {activeEditor === 'binary' && isVfxFile && selectedFile && (
            <VfxWorkbenchPanel
              key={`vfx-wb:${selectedFile.sourceUri}`}
              files={vfxFiles}
              initialUri={selectedFile.sourceUri}
            />
          )}
          {activeEditor === 'binary' && !isMaterialFile && !isVfxFile && selectedFile && classifyWorkspaceOpen(selectedFile.relativePath).openKind !== 'history' && (
            <p className="muted">
              {classifyWorkspaceOpen(selectedFile.relativePath).openKind === 'blocked-scope'
                 ? '当前版本暂不支持 HKX 语义解析。'
                : classifyWorkspaceOpen(selectedFile.relativePath).openKind === 'blocked-no-parser'
                  ? '这个格式还没有确认过的 parser，不能声称已经读懂。'
                    : '这个格式还没有专用编辑器。'}
            </p>
          )}
          {activeEditor === 'binary' && !isMaterialFile && !isVfxFile && !selectedFile && (
            <p className="muted">这个格式还没有专用编辑器。</p>
          )}
  </>;
}
