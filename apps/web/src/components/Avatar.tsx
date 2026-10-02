import styles from './Avatar.module.scss';

/** Iniciais a partir do nome (primeira + última palavra). */
export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '?';
  if (partes.length === 1) return partes[0]!.slice(0, 2).toUpperCase();
  return (partes[0]![0]! + partes[partes.length - 1]![0]!).toUpperCase();
}

/** Avatar circular com as iniciais do nome. */
export function Avatar({ name, size = 32 }: { name: string; size?: number }): React.ReactElement {
  return <span className={styles.iniciais} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} aria-hidden>{iniciais(name)}</span>;
}
