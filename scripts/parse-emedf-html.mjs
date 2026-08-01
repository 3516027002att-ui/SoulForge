/**
 * Research script: parse sekiro-emedf.html (DarkScript3 documentation format)
 * to extract instruction definitions for EMEDF adapter development.
 *
 * This script is for engineering research only. The parsed data is NOT committed
 * to the SoulForge repository. SoulForge uses an external-only adapter that reads
 * EMEDF data from user-provided files.
 *
 * Usage: node scripts/parse-emedf-html.mjs <path-to-sekiro-emedf.html>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error('Usage: node scripts/parse-emedf-html.mjs <path-to-sekiro-emedf.html>');
  process.exit(1);
}

const html = readFileSync(resolve(htmlPath), 'utf-8');

// Parse instruction definitions from HTML
// Format: <h3 id="Name"><code>Name</code></a> <span class="sectioninfo">Instruction bank[id]</span></h3>
// Followed by: <pre>Name(\n    type<enum> argName,\n    ...)</pre>

const instructions = [];
const instrRegex = /<h3 id="([^"]+)">.*?<code>([^<]+)<\/code>.*?Instruction (\d+)\[(\d+)\]/gs;
const preRegex = /<pre>([\s\S]*?)<\/pre>/g;

// Split by instruction sections
const sections = html.split(/<section class="instr/);

for (const section of sections.slice(1)) {
  const h3Match = section.match(/<h3 id="([^"]+)">.*?<code>([^<]+)<\/code>.*?Instruction (\d+)\[(\d+)\]/s);
  if (!h3Match) continue;

  const [, id, name, bankStr, instrIdStr] = h3Match;
  const bank = parseInt(bankStr, 10);
  const instrId = parseInt(instrIdStr, 10);

  // Find the <pre> block with the function signature
  const preMatch = section.match(/<pre>([\s\S]*?)<\/pre>/);
  if (!preMatch) continue;

  const signature = preMatch[1]
    .replace(/<[^>]+>/g, '') // strip HTML tags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  // Parse arguments from signature
  // Format: FuncName(\n    type argName,\n    type<enum> argName)
  const argsMatch = signature.match(/\(([\s\S]*)\)/);
  const args = [];
  if (argsMatch && argsMatch[1].trim()) {
    const argLines = argsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    for (const argLine of argLines) {
      // Parse: type<enum> argName or type argName or type... argName (vararg)
      const argMatch = argLine.match(/^(\w+)(\.\.\.)?(?:<(\w+)>)?\s+(\w+)$/);
      if (argMatch) {
        const [, typeStr, varargDots, enumName, argName] = argMatch;
        args.push({
          name: argName,
          dsType: typeStr,
          enumName: enumName || null,
          vararg: !!varargDots,
        });
      }
    }
  }

  // Check if unused
  const isUnused = section.includes('sectionunused') || section.includes(' unused');

  instructions.push({
    bank,
    id: instrId,
    name,
    args,
    unused: isUnused,
  });
}

// Map DarkScript3 types to SoulForge EMEDF types
const typeMap = {
  'sbyte': 's8',
  'byte': 'u8',
  'short': 's16',
  'ushort': 'u16',
  'int': 's32',
  'uint': 'u32',
  'float': 'f32',
  'bool': 'bool',
};

// Convert to SoulForge EMEDF format
const emedfRegistry = {
  schemaVersion: 1,
  game: 'sekiro',
  origin: 'imported',
  instructions: instructions.map(instr => ({
    bank: instr.bank,
    id: instr.id,
    name: instr.name,
    args: instr.args.map(arg => ({
      name: arg.name,
      type: typeMap[arg.dsType] || arg.dsType,
      description: arg.enumName ? `enum:${arg.enumName}` : undefined,
      vararg: arg.vararg || undefined,
    })),
  })),
};

// Summary statistics
const bankCounts = {};
for (const instr of instructions) {
  bankCounts[instr.bank] = (bankCounts[instr.bank] || 0) + 1;
}

const totalArgs = instructions.reduce((sum, i) => sum + i.args.length, 0);
const unusedCount = instructions.filter(i => i.unused).length;
const varargInstructions = instructions.filter(i => i.args.some(a => a.vararg));

console.log(JSON.stringify({
  totalInstructions: instructions.length,
  totalArgs,
  unusedCount,
  varargInstructionCount: varargInstructions.length,
  varargInstructions: varargInstructions.map(i => `${i.bank}:${i.id} ${i.name}`),
  bankCounts,
  typeDistribution: Object.fromEntries(
    Object.entries(
      instructions.flatMap(i => i.args).reduce((acc, a) => {
        acc[a.dsType] = (acc[a.dsType] || 0) + 1;
        return acc;
      }, {})
    ).sort((a, b) => b[1] - a[1])
  ),
}, null, 2));

// Write full registry to temp file for inspection
const outPath = resolve(process.env.TEMP || '/tmp', 'sekiro-emedf-parsed.json');
writeFileSync(outPath, JSON.stringify(emedfRegistry, null, 2));
console.log(`\nFull registry written to: ${outPath}`);
