/**
 * Deterministic Bounded Cursor Context Analyzer for DarkScript3 / EMEVD source.
 *
 * Provides syntax-tolerant contextual inspection for live editing:
 * - Unclosed calls (e.g. `ShootBullet(` or `ShootBullet(10000, `)
 * - Multi-line nested calls and predicates (e.g. `WaitFor(\n  CharacterDead(X0_4)\n  && CharacterHasSpEffect(|`)
 * - Active argument index & argument range tracking
 * - Enclosing $Event and formal parameter slot discovery (X0_4, X4_4, etc.)
 * - Bounded lookback/lookahead to maintain sub-millisecond latency on 70k-line documents.
 */

export interface ArgumentSpan {
  index: number;
  text: string;
  from: number;
  to: number;
}

export interface EnclosingEventInfo {
  eventId: number;
  restBehavior: string;
  from: number;
  to?: number;
  /** Event parameter slots observed in this event, e.g. ["X0_4", "X4_4"]. */
  parameterSlots: string[];
}

export interface ActiveCallInfo {
  name: string;
  nameFrom: number;
  nameTo: number;
  openParenPos: number;
  closeParenPos?: number;
  activeArgumentIndex: number;
  arguments: ArgumentSpan[];
  isClosed: boolean;
}

export interface CurrentWordInfo {
  text: string;
  from: number;
  to: number;
}

export interface EventCursorContext {
  offset: number;
  lineNumber: number;
  columnNumber: number;
  isInComment: boolean;
  isInString: boolean;
  activeCall: ActiveCallInfo | null;
  enclosingEvent: EnclosingEventInfo | null;
  isInWaitFor: boolean;
  nestingDepth: number;
  currentWord: CurrentWordInfo | null;
}

interface CallStackFrame {
  name: string;
  nameFrom: number;
  nameTo: number;
  openParenPos: number;
  argStartIndex: number;
  argCount: number;
  args: ArgumentSpan[];
  isWaitFor: boolean;
}

/**
 * Find the bounded window around the cursor.
 * Looks backward for the nearest `$Event(` or at most 5000 characters / 200 lines.
 */
function findBoundedWindow(text: string, offset: number): { windowStart: number; windowEnd: number } {
  const lookbackMax = Math.max(0, offset - 10000);
  let eventHeaderIndex = -1;

  // Search backwards for `$Event(`
  const beforeCursor = text.slice(lookbackMax, offset);
  const regex = /\$Event\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(beforeCursor)) !== null) {
    eventHeaderIndex = lookbackMax + match.index;
  }

  const windowStart = eventHeaderIndex >= 0 ? eventHeaderIndex : lookbackMax;
  
  // Look forward for the next `$Event(` or end of event `});` or limit
  const lookaheadMax = Math.min(text.length, offset + 10000);
  const afterCursor = text.slice(offset, lookaheadMax);
  const nextEventMatch = /\$Event\s*\(|\}\s*\)\s*;/g.exec(afterCursor);
  const windowEnd = nextEventMatch ? offset + nextEventMatch.index + nextEventMatch[0].length : lookaheadMax;

  return { windowStart, windowEnd };
}

/**
 * Analyze cursor context at the given character offset in the document.
 */
export function analyzeCursorContext(text: string, offset: number): EventCursorContext {
  const safeOffset = Math.max(0, Math.min(offset, text.length));

  // Compute line and column (1-based)
  let lineNumber = 1;
  let lastLineStart = 0;
  for (let i = 0; i < safeOffset; i++) {
    if (text[i] === '\n') {
      lineNumber++;
      lastLineStart = i + 1;
    }
  }
  const columnNumber = safeOffset - lastLineStart + 1;

  // Extract current word around cursor
  let currentWord: CurrentWordInfo | null = null;
  let wordStart = safeOffset;
  while (wordStart > 0 && /[A-Za-z0-9_.]/.test(text[wordStart - 1]!)) {
    wordStart--;
  }
  let wordEnd = safeOffset;
  while (wordEnd < text.length && /[A-Za-z0-9_.]/.test(text[wordEnd]!)) {
    wordEnd++;
  }
  if (wordStart < wordEnd) {
    currentWord = {
      text: text.slice(wordStart, wordEnd),
      from: wordStart,
      to: wordEnd
    };
  }

  const { windowStart } = findBoundedWindow(text, safeOffset);

  // Lex / Parse the bounded region
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let stringQuote = '';
  let escapeNext = false;

  let activeCall: ActiveCallInfo | null = null;
  let enclosingEvent: EnclosingEventInfo | null = null;
  let nestingDepth = 0;
  let isInWaitFor = false;

  const callStack: CallStackFrame[] = [];
  const observedEventParams = new Set<string>();

  let i = windowStart;
  let lastIdentifier: { text: string; from: number; to: number } | null = null;

  while (i < text.length) {
    const ch = text[i]!;
    const nextCh = i + 1 < text.length ? text[i + 1]! : '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      if (i === safeOffset) break;
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && nextCh === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (i === safeOffset) break;
      i++;
      continue;
    }

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      if (i === safeOffset) break;
      i++;
      continue;
    }

    // Comment start
    if (ch === '/' && nextCh === '/') {
      if (i <= safeOffset) inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && nextCh === '*') {
      if (i <= safeOffset) inBlockComment = true;
      i += 2;
      continue;
    }

    // String start
    if (ch === '"' || ch === "'") {
      if (i <= safeOffset) {
        inString = true;
        stringQuote = ch;
      }
      i++;
      continue;
    }

    // Identifier / Word scanning
    if (/[A-Za-z_$]/.test(ch)) {
      const idStart = i;
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i]!)) {
        i++;
      }
      const idText = text.slice(idStart, i);
      lastIdentifier = { text: idText, from: idStart, to: i };

      // Collect event parameters (e.g. X0_4, X4_4)
      if (/^X\d+_\d+$/.test(idText)) {
        observedEventParams.add(idText);
      }
      continue;
    }

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Opening parenthesis `(`
    if (ch === '(') {
      nestingDepth++;
      const isCall = lastIdentifier !== null;
      const callName = lastIdentifier ? lastIdentifier.text : '';
      const isEventHeader = callName === '$Event';
      const isWait = callName === 'WaitFor';

      if (isEventHeader) {
        // Lookahead to parse eventId and restBehavior
        const headerSlice = text.slice(i + 1, Math.min(text.length, i + 100));
        const headerMatch = /^\s*(-?\d+)\s*,\s*([A-Za-z0-9_]+)/.exec(headerSlice);
        if (headerMatch) {
          enclosingEvent = {
            eventId: Number(headerMatch[1]),
            restBehavior: headerMatch[2]!,
            from: lastIdentifier!.from,
            parameterSlots: []
          };
        }
      }

      if (isCall && lastIdentifier) {
        const frame: CallStackFrame = {
          name: lastIdentifier.text,
          nameFrom: lastIdentifier.from,
          nameTo: lastIdentifier.to,
          openParenPos: i,
          argStartIndex: i + 1,
          argCount: 0,
          args: [],
          isWaitFor: isWait
        };
        callStack.push(frame);
      }

      lastIdentifier = null;
      i++;
      continue;
    }

    // Comma `,`
    if (ch === ',') {
      const currentCall = callStack.length > 0 ? callStack[callStack.length - 1] : null;
      if (currentCall) {
        const argText = text.slice(currentCall.argStartIndex, i).trim();
        currentCall.args.push({
          index: currentCall.argCount,
          text: argText,
          from: currentCall.argStartIndex,
          to: i
        });
        currentCall.argCount++;
        currentCall.argStartIndex = i + 1;
      }
      lastIdentifier = null;
      i++;
      continue;
    }

    // Closing parenthesis `)`
    if (ch === ')') {
      nestingDepth = Math.max(0, nestingDepth - 1);
      const popped = callStack.pop();
      if (popped) {
        const argText = text.slice(popped.argStartIndex, i).trim();
        if (argText.length > 0 || popped.argCount > 0) {
          popped.args.push({
            index: popped.argCount,
            text: argText,
            from: popped.argStartIndex,
            to: i
          });
          popped.argCount++;
        }

        // If cursor was inside this closed call, record it
        if (safeOffset >= popped.openParenPos + 1 && safeOffset <= i) {
          activeCall = {
            name: popped.name,
            nameFrom: popped.nameFrom,
            nameTo: popped.nameTo,
            openParenPos: popped.openParenPos,
            closeParenPos: i,
            activeArgumentIndex: getActiveArgIndex(popped, safeOffset, text),
            arguments: popped.args,
            isClosed: true
          };
          isInWaitFor = callStack.some((f) => f.isWaitFor) || popped.isWaitFor;
        }
      }
      lastIdentifier = null;
      i++;
      continue;
    }

    // Reset lastIdentifier on other punctuation / operators
    if (/^[;{}[\]]/.test(ch)) {
      lastIdentifier = null;
    }

    // If we've passed the cursor offset, we can check open calls on the stack
    if (i >= safeOffset && !activeCall) {
      if (callStack.length > 0) {
        const innermost = callStack[callStack.length - 1]!;
        // Flush remaining argument up to cursor
        const currentArgText = text.slice(innermost.argStartIndex, safeOffset).trim();
        const pendingArgs = [...innermost.args];
        pendingArgs.push({
          index: innermost.argCount,
          text: currentArgText,
          from: innermost.argStartIndex,
          to: safeOffset
        });

        activeCall = {
          name: innermost.name,
          nameFrom: innermost.nameFrom,
          nameTo: innermost.nameTo,
          openParenPos: innermost.openParenPos,
          activeArgumentIndex: innermost.argCount,
          arguments: pendingArgs,
          isClosed: false
        };
        isInWaitFor = callStack.some((f) => f.isWaitFor);
      }
      break;
    }

    i++;
  }

  // If still unclosed and past end of loop
  if (!activeCall && callStack.length > 0) {
    const innermost = callStack[callStack.length - 1]!;
    activeCall = {
      name: innermost.name,
      nameFrom: innermost.nameFrom,
      nameTo: innermost.nameTo,
      openParenPos: innermost.openParenPos,
      activeArgumentIndex: innermost.argCount,
      arguments: innermost.args,
      isClosed: false
    };
    isInWaitFor = callStack.some((f) => f.isWaitFor);
  }

  if (enclosingEvent) {
    enclosingEvent.parameterSlots = Array.from(observedEventParams).sort();
  }

  const inComment = inLineComment || inBlockComment;

  return {
    offset: safeOffset,
    lineNumber,
    columnNumber,
    isInComment: inComment,
    isInString: inString,
    activeCall,
    enclosingEvent,
    isInWaitFor,
    nestingDepth,
    currentWord
  };
}

function getActiveArgIndex(frame: CallStackFrame, offset: number, text: string): number {
  let count = 0;
  for (let i = frame.openParenPos + 1; i < offset; i++) {
    if (text[i] === ',') {
      count++;
    }
  }
  return count;
}
