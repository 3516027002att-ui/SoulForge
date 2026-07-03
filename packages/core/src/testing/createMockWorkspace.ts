import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface MockWorkspace {
  root: string;
  files: {
    eventText: string;
    mapJson: string;
    paramJson: string;
    msgText: string;
  };
}

export interface CreateMockWorkspaceOptions {
  root?: string;
}

/**
 * Creates a tiny synthetic ModEngine-style workspace.
 *
 * It contains no real game assets. The data is deliberately small and fake, but
 * shaped like SoulForge's v0.1 resource chain:
 *
 * event -> map entity/region -> param row -> msg entry
 */
export async function createMockWorkspace(options: CreateMockWorkspaceOptions = {}): Promise<MockWorkspace> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'soulforge-mock-'));

  const eventDir = join(root, 'event');
  const mapDir = join(root, 'map');
  const paramDir = join(root, 'param');
  const msgDir = join(root, 'msg');

  await mkdir(eventDir, { recursive: true });
  await mkdir(mapDir, { recursive: true });
  await mkdir(paramDir, { recursive: true });
  await mkdir(msgDir, { recursive: true });

  const files = {
    eventText: join(eventDir, 'm11_00_00_00.emevd.txt'),
    mapJson: join(mapDir, 'm11_00_00_00.mockmap.json'),
    paramJson: join(paramDir, 'SpEffectParam.mockparam.json'),
    msgText: join(msgDir, 'Goods.tsv')
  };

  await writeFile(files.eventText, makeEventText(), 'utf8');
  await writeFile(files.mapJson, JSON.stringify(makeMapJson(), null, 2), 'utf8');
  await writeFile(files.paramJson, JSON.stringify(makeParamJson(), null, 2), 'utf8');
  await writeFile(files.msgText, makeMsgText(), 'utf8');

  return { root, files };
}

function makeEventText(): string {
  return `// Synthetic SoulForge event fixture. No real game data.
Event(11002800, "Mock boss intro") {
  InitializeEvent(0, 11002810);
  IfFlagEnabled(flag=11000500);
  EnableCharacter(character=1100800);
  DisplayDialog(textId=1000, anchorEntityId=1100800);
  SetSpEffect(entityId=1100800, spEffectId=2000);
}

Event(11002810, "Mock helper event") {
  DisableCharacter(character=1100800);
}
`;
}

function makeMapJson(): unknown {
  return {
    mapId: 'm11_00_00_00',
    entities: [
      {
        uri: 'map://m11_00_00_00/entity/1100800',
        sourceUri: 'file://map/m11_00_00_00.mockmap.json',
        mapId: 'm11_00_00_00',
        entityId: 1100800,
        name: 'Mock Boss Character',
        kind: 'character',
        model: 'c0000',
        position: [10, 0, 20],
        rotation: [0, 180, 0]
      }
    ],
    regions: [
      {
        uri: 'map://m11_00_00_00/region/1102800',
        sourceUri: 'file://map/m11_00_00_00.mockmap.json',
        mapId: 'm11_00_00_00',
        entityId: 1102800,
        name: 'Mock Trigger Region',
        shape: 'box',
        position: [9, 0, 18],
        rotation: [0, 0, 0],
        size: [3, 3, 3]
      }
    ]
  };
}

function makeParamJson(): unknown {
  return {
    paramName: 'SpEffectParam',
    rows: [
      {
        uri: 'param://SpEffectParam/2000',
        sourceUri: 'file://param/SpEffectParam.mockparam.json',
        paramName: 'SpEffectParam',
        rowId: 2000,
        rowName: 'Mock Intro Effect',
        fields: [
          { name: 'effectEndurance', type: 'f32', value: 5 },
          { name: 'iconId', type: 's32', value: -1 }
        ]
      }
    ]
  };
}

function makeMsgText(): string {
  return `1000\tA mock bell tolls in the distance.
1001\tThis line is intentionally unused.
`;
}
