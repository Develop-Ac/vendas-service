import { createPrivateKey, randomUUID, sign } from 'node:crypto';

/* =============================================================================
   COMPROVANTE DE APROVAÇÃO DE DESCONTO — o que a intranet manda à api-vendas-service
   -----------------------------------------------------------------------------
   Quando um orçamento tem item com desconto acima do máximo do Celta, a gravação
   no ERP exige a liberação de um gestor. A intranet é quem autentica esse gestor
   e confere as permissões; a API do Celta não lê usuários — recebe este token
   assinado e só confere assinatura, validade, uso único e o vínculo item a item.

   Formato: JWT com EdDSA (Ed25519). A chave privada fica aqui
   (ORCAMENTO_APROVACAO_CHAVE_PRIVADA); a API guarda só a pública. O token é
   emitido na importação, a partir da aprovação já registrada no orçamento, com
   validade curta: os itens são exatamente os que a API vai gravar no bloqueio
   (lidos da prévia POST /orcamentos/:empresa/excedentes da própria API).
   ============================================================================= */

export interface ItemAprovado {
  item: number;
  pro_codigo: number;
  quantidade: number;
  unitario: number;
  perc_descto: number;
  valor_descto: number;
  efetivo: number;
  permitido: number;
}

export interface Aprovacao {
  id: string;
  empresa: number;
  cli_codigo: number;
  /** USUARIOS.USU_CODIGO do Celta de quem aprovou e de quem pediu */
  aprovador: number;
  solicitante: number;
  justificativa: string;
  /** desconto do cabeçalho enviado ao Celta */
  valor_descto: number;
  itens: ItemAprovado[];
  iat: number;
  exp: number;
}

/** Validade do comprovante: só o tempo da importação. */
export const VALIDADE_S = 10 * 60;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const HEADER = b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));

/** PEM da chave privada como vem do .env (entre aspas, com `\n` escapado) ou com quebras reais. */
export function chavePrivada(pem: string | undefined) {
  const s = (pem ?? '').trim();
  if (!s) return null;
  return createPrivateKey(s.replace(/\\n/g, '\n'));
}

export function assinarComprovante(dados: Omit<Aprovacao, 'id' | 'iat' | 'exp'>, pem: string | undefined): string {
  const chave = chavePrivada(pem);
  if (!chave) throw new Error('ORCAMENTO_APROVACAO_CHAVE_PRIVADA não configurada.');
  const iat = Math.floor(Date.now() / 1000);
  const aprovacao: Aprovacao = { id: randomUUID(), ...dados, iat, exp: iat + VALIDADE_S };
  const payload = b64(JSON.stringify(aprovacao));
  return `${HEADER}.${payload}.${b64(sign(null, Buffer.from(`${HEADER}.${payload}`), chave))}`;
}
