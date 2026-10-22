import type { ReactElement } from 'react';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { MsgTableEditor } from '../components/MsgTableEditor.js';
import { PanelErrorBoundary } from '../components/PanelErrorBoundary.js';
import { MsbScenePanel, type MsbScenePanelProps } from '../editors/MsbScenePanel.js';
import { FmgWorkbenchPanel } from '../editors/FmgWorkbenchPanel.js';
import { EventSourceWorkbenchPanel } from '../editors/EventSourceWorkbenchPanel.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import type { MapDocumentController } from './useMapDocumentController.js';
import type { TextDocumentController } from './useTextDocumentController.js';
import type { EventDocumentController } from './useEventDocumentController.js';
import type { NavigationController } from './useNavigationController.js';

/** These views project loaded state and retain the original workbench lifecycle/commands. */
export function PlainTextEditorView({ document: resource }: { document: Pick<ResourceDocumentController, 'editDirty' | 'saveCurrentText' | 'setEditText' | 'lastSavedText' | 'hasMsgTable' | 'msgRows' | 'addMsgRow' | 'removeMsgRow' | 'updateMsgRow' | 'editText' | 'canEditText' | 'saveDiagnostics' | 'selectedFile'> }): ReactElement {
  const { editDirty, saveCurrentText, setEditText, lastSavedText, hasMsgTable, msgRows, addMsgRow, removeMsgRow, updateMsgRow, editText, canEditText, saveDiagnostics, selectedFile } = resource;
  return <section className="text-editor-panel">
              <div className="text-editor-toolbar">
                <strong>文本编辑器</strong>
                <div>
                  <button type="button" disabled={!editDirty} onClick={() => void saveCurrentText()}>保存</button>
                  <button type="button" disabled={!editDirty} onClick={() => setEditText(lastSavedText)}>还原</button>
                </div>
              </div>
              {hasMsgTable && (
                <MsgTableEditor
                  rows={msgRows}
                  onAdd={addMsgRow}
                  onRemove={removeMsgRow}
                  onUpdate={updateMsgRow}
                />
              )}
              <textarea
                value={editText}
                readOnly={!canEditText}
                onChange={(event) => setEditText(event.target.value)}
                spellCheck={false}
                /* 主编辑器此前无可访问名：屏幕阅读器只念「文本区域」，用户无从
                   判断正在编辑哪个资源。只读态也要说明，否则「改不了」在无障碍
                   视角下是静默的。 */
                aria-label={selectedFile
                  ? `${selectedFile.relativePath} 文本内容${canEditText ? '' : '（只读）'}`
                  : '资源文本内容（未选择文件）'}
                aria-readonly={!canEditText}
              />
              {saveDiagnostics.length > 0 && (
                <div className="save-diagnostics">
                  {saveDiagnostics.map((message) => <span key={message}>{message}</span>)}
                </div>
              )}
            </section>;
}

export function MapEditorView({ selectedFile, document: map, openFailure }: {
  selectedFile: Pick<RendererIndexedFile, 'sourceUri' | 'relativePath'> | null;
  document: Pick<MapDocumentController, 'msbSourceHash' | 'msbParts' | 'msbRegions' | 'msbRoutes' | 'msbModels' | 'msbEvents' | 'msbSourceCounts' | 'setMsbSourceHash'>;
  openFailure: Exclude<MsbScenePanelProps['openFailure'], undefined>;
}): ReactElement {
  const { msbSourceHash, msbParts, msbRegions, msbRoutes, msbModels, msbEvents, msbSourceCounts, setMsbSourceHash } = map;
  return <MsbScenePanel
                key={`${selectedFile?.sourceUri ?? ''}:${msbSourceHash ?? ''}:${msbParts.length}:${msbRegions.length}:${msbRoutes.length}`}
                mapResourceUri={selectedFile?.sourceUri ?? ''}
                sourcePath={selectedFile?.relativePath ?? ''}
                game="sekiro"
                revision={msbSourceHash ?? '未加载'}
                models={msbModels}
                parts={msbParts}
                regions={msbRegions}
                events={msbEvents}
                routes={msbRoutes}
                sourceCounts={msbSourceCounts}
                onRevisionChange={setMsbSourceHash}
                openFailure={openFailure}
              />;
}

export function TextEditorView({ selectedFile, document: text, live, revealRequest, onRevealHandled }: {
  selectedFile: Pick<RendererIndexedFile, 'sourceUri'> | null;
  document: Pick<TextDocumentController, 'fmgEntries' | 'submitFmgEntry'>;
  live: boolean; revealRequest: NavigationController['fmgRevealRequest'];
  onRevealHandled: NavigationController['clearFmgRevealRequest'];
}): ReactElement {
  const { fmgEntries, submitFmgEntry } = text;
  return <FmgWorkbenchPanel
                key={selectedFile?.sourceUri ?? ''}
                resourceUri={selectedFile?.sourceUri ?? ''}
                entries={fmgEntries}
                live={live}
                revealRequest={revealRequest}
                onRevealHandled={onRevealHandled}
                onMutation={submitFmgEntry}
              />;
}

export function EventEditorView({ active: showEventWorkbench, document: event, onJumpResource: jumpToResource }: {
  active: boolean; document: Pick<EventDocumentController, 'eventOpening' | 'eventSourcePreview' | 'eventPendingTab' | 'submitEventDsl'>;
  onJumpResource: NavigationController['jumpToResource'];
}): ReactElement {
  const { eventOpening, eventSourcePreview, eventPendingTab, submitEventDsl } = event;
  return <PanelErrorBoundary key="panel-boundary:event" label="Event 源码工作台">
            <div hidden={!showEventWorkbench} className="event-source-host">
              <EventSourceWorkbenchPanel
                /* EVENT-30B：工作台自己管理多文档标签与 dirty；App 只按资源 URI
                   提供最近一次打开/刷新的有界投影（pendingTab），并把 DSL 提交能力
                   上抛。key 固定，切资源时工作台不重挂载，标签与未提交编辑得以保留。 */
                active={showEventWorkbench}
                opening={eventOpening}
                openingPreview={eventSourcePreview}
                pendingTab={eventPendingTab}
                onJumpResource={jumpToResource}
                onDslSubmit={submitEventDsl}
              />
            </div>
          </PanelErrorBoundary>;
}
