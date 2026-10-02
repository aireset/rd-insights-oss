import styles from './Badge.module.scss';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

/** Badge de status genérico. */
export function Badge({ label, variant = 'neutral' }: { label: string; variant?: BadgeVariant }): React.ReactElement {
  return (
    <span className={`${styles.badge} ${styles[variant]}`}>
      <span className={styles.dot} />
      {label}
    </span>
  );
}
