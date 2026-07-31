import { useMemo, useState, type ReactElement } from 'react';
import { FlverViewer } from './FlverViewer.js';

export interface FlverMaterialSummary {
  name: string;
  mtdPath?: string;
  textureCount: number;
}

export interface FlverBoneSummary {
  name: string;
  parentIndex: number;
  nextSiblingIndex: number;
}

export interface FlverMeshSummary {
  vertexCount: number;
  materialIndex: number;
  indexFormat: number;
}

export interface FlverDocumentData {
  format: string;
  internalVersion: number;
  sourceSize: number;
  sourceHash: string;
  boneCount: number;
  materialCount: number;
  meshCount: number;
  faceCount: number;
  totalFaceCount: number;
  boundingBox?: { min: number[]; max: number[] };
  authority: string;
  materials?: FlverMaterialSummary[];
  bones?: FlverBoneSummary[];
  meshes?: FlverMeshSummary[];
}

export interface FlverWorkbenchPanelProps {
  resourceUri: string;
  data: FlverDocumentData | null;
}

/**
 * FLVER 3D 模型只读面板：显示骨骼、材质、网格和包围盒信息。
 */
export function FlverWorkbenchPanel(props: FlverWorkbenchPanelProps): ReactElement {
  const [tab, setTab] = useState<'materials' | 'bones' | 'meshes'>('materials');
  const [query, setQuery] = useState('');
  const [selectedMeshIndex, setSelectedMeshIndex] = useState(0);
  const data = props.data;

  const filteredMaterials = useMemo(() => {
    if (!data?.materials) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.materials;
    return data.materials.filter(
      (m) => m.name.toLowerCase().includes(q) || (m.mtdPath ?? '').toLowerCase().includes(q)
    );
  }, [data?.materials, query]);

  const filteredBones = useMemo(() => {
    if (!data?.bones) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.bones;
    return data.bones.filter((b) => b.name.toLowerCase().includes(q));
  }, [data?.bones, query]);

  const bbox = data?.boundingBox;

  return (
    <section className="panel" aria-label="FLVER 3D 模型面板">
      <header className="panel-header">
        <h3>FLVER 3D 模型 · V0.6 只读预览</h3>
        <span className="muted">
          {data
            ? `${data.boneCount} bones · ${data.materialCount} mats · ${data.meshCount} meshes · ${data.faceCount.toLocaleString()} faces · ${data.authority}`
            : '未加载'}
        </span>
      </header>
      <p className="muted" role="note">
        资产只读与导出线已延期至 V0.6：本面板为只读预览，不属于 V0.5 发布编辑器清单。
      </p>
      {!data && <p className="muted">选择 .flver 文件以查看 3D 模型数据。</p>}
      {data && (
        <>
          {bbox && (
            <div className="row gap" style={{ marginBottom: 8 }}>
              <span className="muted">
                包围盒：({bbox.min.map((v) => v.toFixed(2)).join(', ')}) → ({bbox.max.map((v) => v.toFixed(2)).join(', ')})
              </span>
            </div>
          )}
          <div className="row gap">
            <button className={tab === 'materials' ? 'active' : ''} onClick={() => setTab('materials')}>
              材质 ({data.materialCount})
            </button>
            <button className={tab === 'bones' ? 'active' : ''} onClick={() => setTab('bones')}>
              骨骼 ({data.boneCount})
            </button>
            <button className={tab === 'meshes' ? 'active' : ''} onClick={() => setTab('meshes')}>
              网格 ({data.meshCount})
            </button>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="搜索名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 300, marginTop: 8 }}>
            {tab === 'materials' && (
              <table className="table">
                <thead>
                  <tr><th>名称</th><th>MTD 路径</th><th>纹理数</th></tr>
                </thead>
                <tbody>
                  {filteredMaterials.slice(0, 100).map((m, i) => (
                    <tr key={i}>
                      <td>{m.name}</td>
                      <td className="muted">{m.mtdPath?.split('\\').pop() ?? '—'}</td>
                      <td>{m.textureCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'bones' && (
              <table className="table">
                <thead>
                  <tr><th>名称</th><th>父骨骼</th><th>下一兄弟</th></tr>
                </thead>
                <tbody>
                  {filteredBones.slice(0, 200).map((b, i) => (
                    <tr key={i}>
                      <td>{b.name}</td>
                      <td>{b.parentIndex}</td>
                      <td>{b.nextSiblingIndex}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'meshes' && (
              <table className="table">
                <thead>
                  <tr><th>#</th><th>顶点数</th><th>材质索引</th><th>索引格式</th></tr>
                </thead>
                <tbody>
                  {(data.meshes ?? []).slice(0, 100).map((m, i) => (
                    <tr
                      key={i}
                      className={i === selectedMeshIndex ? 'selected' : ''}
                      onClick={() => setSelectedMeshIndex(i)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{i}</td>
                      <td>{m.vertexCount}</td>
                      <td>{m.materialIndex}</td>
                      <td>{m.indexFormat === 6 ? 'uint16' : m.indexFormat}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <FlverViewer
              sourceUri={props.resourceUri}
              meshIndex={selectedMeshIndex}
              boundingBox={data.boundingBox as { min: number[]; max: number[] } | undefined}
              boneCount={data.boneCount}
              meshCount={data.meshCount}
            />
          </div>
        </>
      )}
    </section>
  );
}
