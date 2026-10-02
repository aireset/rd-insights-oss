import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Criptografia AT-REST de segredos. AES-256-GCM autenticado.
 *
 * Formato do valor cifrado: `enc:v1:<iv>:<tag>:<cipher>` (partes em base64). O
 * prefixo permite DETECTAR se um valor no banco já está cifrado ou ainda é texto
 * puro (`isEncrypted`) — habilita a migração GRADUAL: `decryptSecret` aceita o
 * legado em texto puro sem quebrar; `encryptSecret` sempre cifra na escrita.
 *
 * Chave: variável de ambiente `SECRETS_KEY`.
 *  - 32 bytes em base64 (ideal): `openssl rand -base64 32` — usada direto.
 *  - qualquer outra string: derivada para 32 bytes via scrypt (salt fixo, para
 *    ser determinística entre reinícios).
 *  - AUSENTE: modo PASSTHROUGH para desenvolvimento. A configuração de produção
 *    exige SECRETS_KEY antes de iniciar a aplicação.
 *
 * NUNCA logar/retornar o valor decifrado além do uso interno.
 */

const PREFIX = 'enc:v1:';
/** Salt fixo da derivação por passphrase — determinístico é obrigatório (senão não decifra após restart). */
const SCRYPT_SALT = 'rd-insights-secrets-v1';

let cache: { raw: string; key: Buffer | null } | null = null;

/** Resolve (e memoiza) a chave de 32 bytes a partir de `SECRETS_KEY`. `null` = passthrough. */
function resolveKey(): Buffer | null {
  const raw = process.env.SECRETS_KEY ?? '';
  if (cache && cache.raw === raw) return cache.key;
  let key: Buffer | null = null;
  if (raw !== '') {
    const asB64 = Buffer.from(raw, 'base64');
    key = asB64.length === 32 ? asB64 : scryptSync(raw, SCRYPT_SALT, 32);
  }
  cache = { raw, key };
  return key;
}

/** true quando `SECRETS_KEY` está configurada (não estamos em passthrough). */
export function secretsKeyConfigured(): boolean {
  return resolveKey() !== null;
}

/** true se o valor já está no formato cifrado (`enc:v1:…`). Aceita legado texto puro (false). */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Cifra um segredo. Idempotente (valor já cifrado volta igual). Preserva
 * null/undefined/'' (nada a cifrar). Sem `SECRETS_KEY` → devolve o texto puro
 * (passthrough) — a migração cifra depois.
 */
export function encryptSecret<T extends string | null | undefined>(plain: T): T {
  if (typeof plain !== 'string' || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  const key = resolveKey();
  if (!key) return plain; // passthrough
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}` as T;
}

/**
 * Decifra um segredo. Aceita o LEGADO em texto puro (devolve como está). Lança
 * erro CLARO — sem vazar o conteúdo — se o dado foi adulterado (tag GCM inválida)
 * ou se há valor cifrado mas `SECRETS_KEY` sumiu.
 */
export function decryptSecret<T extends string | null | undefined>(stored: T): T {
  if (typeof stored !== 'string') return stored;
  if (!isEncrypted(stored)) return stored; // texto puro legado
  const key = resolveKey();
  if (!key) {
    throw new Error(
      'SECRETS_KEY ausente, mas há segredo cifrado no banco que não pode ser decifrado. Configure SECRETS_KEY.',
    );
  }
  const [, , ivB64, tagB64, dataB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Segredo cifrado com formato inválido.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8') as T;
  } catch {
    // NUNCA incluir o valor (nem o cifrado) na mensagem.
    throw new Error('Falha ao decifrar segredo (chave incorreta ou dado adulterado).');
  }
}
