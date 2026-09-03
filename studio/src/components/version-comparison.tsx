export function VersionComparison({ current, previous }: { current: string; previous?: string }) {
  if (!previous) return null;
  return <details><summary>Comparer avec la version précédente</summary><div className="form-grid" style={{marginTop:16}}><div><span className="eyebrow">Avant</span><pre style={{whiteSpace:"pre-wrap",background:"#f7f8f5",padding:16,borderRadius:10,maxHeight:360,overflow:"auto"}}>{previous}</pre></div><div><span className="eyebrow">Après</span><pre style={{whiteSpace:"pre-wrap",background:"#f1f8e7",padding:16,borderRadius:10,maxHeight:360,overflow:"auto"}}>{current}</pre></div></div></details>;
}
