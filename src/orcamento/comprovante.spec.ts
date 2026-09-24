import { generateKeyPairSync, verify } from 'node:crypto';
import { assinarComprovante, chavePrivada, VALIDADE_S } from './comprovante';

describe('comprovante de aprovação', () => {
  const par = generateKeyPairSync('ed25519');
  const pem = par.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const dados = {
    empresa: 3,
    cli_codigo: 40275,
    aprovador: 19,
    solicitante: 200,
    justificativa: 'Intranet ORC-000262',
    valor_descto: 0,
    itens: [{ item: 1, pro_codigo: 21367, quantidade: 1, unitario: 937.3, perc_descto: 8, valor_descto: 74.98, efetivo: 8, permitido: 5 }],
  };

  it('emite um JWT EdDSA que a chave pública confere, com id único e validade curta', () => {
    const token = assinarComprovante(dados, pem);
    const [h, p, s] = token.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload).toMatchObject(dados);
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.exp - payload.iat).toBe(VALIDADE_S);
    expect(verify(null, Buffer.from(`${h}.${p}`), par.publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(assinarComprovante(dados, pem)).not.toBe(token);
  });

  it('aceita o PEM com as quebras escapadas, como vem do .env', () => {
    expect(chavePrivada(pem.replace(/\n/g, '\\n'))).not.toBeNull();
    expect(chavePrivada(undefined)).toBeNull();
    expect(() => assinarComprovante(dados, '')).toThrow(/ORCAMENTO_APROVACAO_CHAVE_PRIVADA/);
  });
});
