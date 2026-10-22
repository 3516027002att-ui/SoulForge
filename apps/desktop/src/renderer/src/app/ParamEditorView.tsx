import type { ReactElement } from 'react';
import { paramPhysicalRowKey, type ParamPhysicalRowIdentity } from '@soulforge/shared';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { ParamWorkbench } from '../workbench/ParamWorkbench.js';
import { ParamTablePanel } from '../editors/ParamTablePanel.js';
import { ParamDefPanel } from '../editors/ParamDefPanel.js';
import type { EditorId } from '../workbench/selectEditor.js';
import type { ParamDocumentController } from './useParamDocumentController.js';
import type { ParamMutationController } from './useParamMutationController.js';

export interface ParamEditorViewProps {
  activeEditor: EditorId;
  selectedFile: RendererIndexedFile | null;
  paramWorkbenchFile: RendererIndexedFile | null;
  document: Pick<ParamDocumentController, 'paramFieldEnums' | 'paramFieldDefs' | 'paramTypeName' | 'paramRowDataSize' | 'paramFieldDefsOrigin' | 'paramLive' | 'paramSourceHash' | 'paramRows' | 'paramRowCount' | 'paramIndexLoading' | 'paramIndexDiagnostic' | 'readParamRowsForPanel' | 'paramRevealRowId' | 'setParamRevealRowId' | 'paramFieldDefinition' | 'paramFieldDefsDiagnostic' | 'paramRowPayloads' | 'applyParamFieldMutationFromPanel'>;
  mutations: ParamMutationController;
}

/** PARAM presentation keeps container and raw-row controls with their actual document/command owners. */
export function ParamEditorView({ activeEditor, selectedFile, paramWorkbenchFile, document: param, mutations }: ParamEditorViewProps): ReactElement {
  const { paramFieldEnums, paramFieldDefs, paramTypeName, paramRowDataSize, paramFieldDefsOrigin, paramLive, paramSourceHash, paramRows, paramRowCount, paramIndexLoading, paramIndexDiagnostic, readParamRowsForPanel, paramRevealRowId, setParamRevealRowId, paramFieldDefinition, paramFieldDefsDiagnostic, paramRowPayloads, applyParamFieldMutationFromPanel } = param;
  const { applyContainerParamFieldMutation, applyContainerParamRowNameMutation, applyContainerParamRowMutation, applyParamRowMutationFromPanel } = mutations;
  return <>
{paramWorkbenchFile && (
            <ParamWorkbench
              key={`param-wb:${paramWorkbenchFile.sourceUri}`}
              containerUri={paramWorkbenchFile.sourceUri}
              containerLabel={paramWorkbenchFile.relativePath}
              fieldEnums={paramFieldEnums}
              resolveDefinition={(typeName, rowDataSizeFromPage) => {
                // 只在类型名与行宽都对得上时给出定义：行宽不符说明这份元数据
                // 描述的是另一个版本的 param，按它解码会全部错位。
                if (!paramFieldDefs || paramFieldDefs.length === 0) return null;
                if (paramTypeName !== typeName) return null;
                if (paramRowDataSize !== rowDataSizeFromPage) return null;
                return {
                  schemaVersion: 1,
                  typeName,
                  version: 0,
                  rowDataSize: paramRowDataSize,
                  // 授信来源由主进程裁定，不在此处硬写（见 paramFieldDefsOrigin）。
                  origin: paramFieldDefsOrigin,
                  fields: paramFieldDefs
                };
              }}
              onApplyFieldMutation={applyContainerParamFieldMutation}
              onApplyRowNameMutation={applyContainerParamRowNameMutation}
              onApplyRowMutation={applyContainerParamRowMutation}
            />
          )}
{activeEditor === 'param-rows' && (
            <>
              {/* 同上：删掉「实时 Bridge PARAM · hash … / 空行（未选中可解析 PARAM
                  或读取失败）」标题行。 */}
              <ParamTablePanel
                key={`${selectedFile?.sourceUri ?? ''}:${paramLive ? 'live' : 'empty'}:${paramSourceHash ?? ''}`}
                typeName={paramTypeName}
                resourceUri={selectedFile?.sourceUri ?? ''}
                rows={paramRows}
                live={paramLive}
                rowCount={paramRowCount}
                indexLoading={paramIndexLoading}
                indexDiagnostic={paramIndexDiagnostic}
                onReadRows={readParamRowsForPanel}
                revealRowId={paramRevealRowId}
                onRevealHandled={() => setParamRevealRowId(null)}
                onMutation={applyParamRowMutationFromPanel}
              />
              {paramLive && paramFieldDefinition !== null && paramFieldDefsOrigin === 'fixture' && (
                <p className="muted" data-testid="param-fielddefs-readonly">
                  字段当前只读。
                </p>
              )}
              {paramLive && paramFieldDefinition === null && paramFieldDefsDiagnostic !== null && (
                <p className="muted" data-testid="param-fielddefs-missing">
                  无字段定义（{paramFieldDefsDiagnostic.code}）：{paramFieldDefsDiagnostic.message}
                </p>
              )}
              <ParamDefPanel
                key={`paramdef:${paramLive ? 'live' : 'empty'}:${paramSourceHash ?? ''}`}
                typeName={paramLive ? paramTypeName : '未加载'}
                rowDataSize={paramLive ? paramRowDataSize : 0}
                origin={paramLive ? '待绑定' : 'fixture'}
                resourceUri={selectedFile?.sourceUri ?? ''}
                live={paramLive}
                definition={paramFieldDefinition}
                rows={paramRows}
                getRowDataBase64={(identity) => paramRowPayloads.get(paramPhysicalRowKey(identity))}
                {...(paramLive && selectedFile
                  ? {
                    // S29：裸 .param 字段直写（applyParamFieldMutation → Patch Engine），
                    // 不进审查队列；状态/重读由 applyParamFieldMutationFromPanel 负责。
                    onApplyFieldMutation: (input: {
                      rowId: number;
                      identity: ParamPhysicalRowIdentity;
                      fieldId: string;
                      value: number | string | boolean;
                      rowDataBase64: string;
                      definition: unknown;
                    }) => applyParamFieldMutationFromPanel(input)
                  }
                  : {})}
              />
            </>
          )}
  </>;
}
