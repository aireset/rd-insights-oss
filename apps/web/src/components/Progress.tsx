import styles from './Progress.module.scss';

/** Barra de progresso. `pct` nulo/ausente = indeterminada (listras animadas), sem inventar porcentagem. */
export function Progress({ pct }: { pct: number | null }): React.ReactElement {
  const det = pct !== null;
  return (
    <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={det ? pct : undefined} data-indeterminate={det ? undefined : 'true'}>
      <div className={det ? styles.fill : `${styles.fill} ${styles.indeterminate}`} style={det ? { width: `${pct}%` } : undefined} />
    </div>
  );
}

/** % concluída pelo cursor/total de páginas; null quando o RD não informou o total. */
export function pctPaginas(cursor: number, total: number | undefined): number | null {
  return total && total > 0 ? Math.min(100, Math.round((cursor / total) * 100)) : null;
}
