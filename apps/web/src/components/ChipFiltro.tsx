import { X } from 'lucide-react';
import styles from './ChipFiltro.module.scss';

/** Chip de filtro ativo, com × para limpar. Fica acima da lista. */
export function ChipFiltro({ label, onClear, clearLabel }: { label: string; onClear: () => void; clearLabel: string }): React.ReactElement {
  return (
    <div className={styles.chip}>
      <span>{label}</span>
      <button type="button" onClick={onClear} aria-label={clearLabel} title="Limpar filtro"><X size={13} aria-hidden /></button>
    </div>
  );
}
