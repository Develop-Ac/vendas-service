/**
 * Papéis de vendas no servidor — o espelho de `lib/vendas/papel.ts` do front.
 * GESTÃO = supervisão do atacado ou gerência (hub do cadastro), ou
 * admin/diretoria (setor). GERÊNCIA = só gerência e admin/diretoria: é quem
 * define metas e o semáforo do departamento; o supervisor só observa.
 */
const HUBS_GESTAO = new Set(['SUPERVISAO_ATACADO', 'GERENCIA']);
const SETORES_DIRECAO = new Set(['ADMIN', 'ADMINISTRADOR', 'DIRETORIA']);

type UsuarioPapel = { vendas_hub_inicial?: string | null; setor?: string | null } | null | undefined;

export function ehGestaoVendas(u: UsuarioPapel): boolean {
  const hub = (u?.vendas_hub_inicial ?? '').toUpperCase();
  const setor = (u?.setor ?? '').toUpperCase();
  return HUBS_GESTAO.has(hub) || SETORES_DIRECAO.has(setor);
}

export function ehGerenciaVendas(u: UsuarioPapel): boolean {
  const hub = (u?.vendas_hub_inicial ?? '').toUpperCase();
  const setor = (u?.setor ?? '').toUpperCase();
  return hub === 'GERENCIA' || SETORES_DIRECAO.has(setor);
}
