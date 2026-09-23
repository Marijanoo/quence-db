export interface DiffRow {
  left: number | null   // line index into the left text
  right: number | null  // line index into the right text
  kind: 'same' | 'changed' | 'left' | 'right'
}

export const splitLines = (text: string) => (text ? text.split('\n') : [])

// Aligns two texts line by line for a side-by-side view (LCS-based). Adjacent removed/added runs
// are paired up as "changed" rows so edits line up next to each other.
export function sideBySideDiff(leftText: string, rightText: string): DiffRow[] {
  const a = splitLines(leftText)
  const b = splitLines(rightText)
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let removed: number[] = []
  let added: number[] = []
  const flush = () => {
    const n = Math.max(removed.length, added.length)
    for (let k = 0; k < n; k++) {
      const left = removed[k] ?? null
      const right = added[k] ?? null
      rows.push({ left, right, kind: left !== null && right !== null ? 'changed' : left !== null ? 'left' : 'right' })
    }
    removed = []
    added = []
  }

  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush()
      rows.push({ left: i++, right: j++, kind: 'same' })
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      added.push(j++)
    } else {
      removed.push(i++)
    }
  }
  flush()
  return rows
}
