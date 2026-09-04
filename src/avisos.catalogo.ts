import type { Catalogo } from './common/avisos/avisos-client';

/**
 * O QUE O VENDAS-SERVICE EMITE — catálogo sincronizado no boot com o
 * avisos-service (regra nasce inativa; liga-se em /avisos/config).
 *
 * Régua: canal `desktop` (balão do Windows na Estação) só no que exige ação do
 * vendedor AGORA. O resto fica no sino/mural. Alvo padrão = usuário (o
 * vendedor dono da carteira, resolvido por sis_usuarios.vendas_rep_codigo).
 * Links apontam para a Estação com o cliente (e o orçamento) já abertos.
 */
export const CATALOGO_VENDAS: Catalogo = {
  'fila.dia': {
    descricao: 'Fila do dia gerada para o vendedor (carga diária).',
    titulo: 'Fila de hoje: {total} cliente(s)',
    corpo: '{resgates} resgate(s) · {escaladas} escalada(s)',
    link: '/vendas/estacao',
    canais: ['badge', 'desktop'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
    agrupar: true,
    cooldown_min: 720,
  },
  'fila.escalada': {
    descricao: 'Tarefa da fila passou do prazo de contato e virou ESCALADA.',
    titulo: 'Sem contato há {dias} dias: {cliente}',
    corpo: 'Tarefa escalada · {motivo}',
    link: '/vendas/estacao?cli={cli}',
    canais: ['badge', 'mural', 'desktop'],
    prioridade: 'alta',
    alvo: { tipo: 'usuario' },
  },
  'resgate.sla': {
    descricao: 'Cliente curva A em risco sem contato dentro do SLA de 48 h.',
    titulo: 'Resgate atrasado: {cliente}',
    corpo: 'Curva A sem contato há {horas} h · SLA {sla} h',
    link: '/vendas/estacao?cli={cli}',
    canais: ['badge', 'mural', 'desktop'],
    prioridade: 'alta',
    alvo: { tipo: 'usuario' },
  },
  'orcamento.vencendo': {
    descricao: 'Orçamento enviado vence amanhã sem venda nem desfecho.',
    titulo: 'Orçamento {numero} vence amanhã sem resposta',
    corpo: '{cliente} · {total}',
    link: '/vendas/estacao?cli={cli}&orc={id}',
    canais: ['badge', 'desktop'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
  },
  'orcamento.sem_desfecho': {
    descricao: 'Orçamento do ERP completou 7 dias sem venda: registrar o motivo.',
    titulo: 'Orçamento {numero} do ERP sem desfecho',
    corpo: '{cliente} · {total} · informe o motivo (1 toque)',
    link: '/vendas/carteirizacao',
    canais: ['badge'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
  },
  'carteira.risco': {
    descricao: 'Cliente da carteira entrou em risco de inativação.',
    titulo: 'Risco de inativação: {cliente}',
    corpo: 'Curva {curva} · {dias} dias sem compra',
    link: '/vendas/estacao?cli={cli}',
    canais: ['badge'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
    cooldown_min: 1440,
  },
  'carteira.compra': {
    descricao: 'Cliente da carteira comprou (venda no ERP).',
    titulo: '{cliente} comprou: {total}',
    corpo: 'Venda no ERP fechou a tarefa da fila',
    link: '/vendas/carteirizacao',
    canais: ['badge'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
  },
  'carteira.mudou': {
    descricao: 'Cliente entrou ou saiu da carteira (carteirização do ERP).',
    titulo: 'Carteira: {cliente} {movimento}',
    corpo: '{detalhe}',
    link: '/vendas/carteirizacao',
    canais: ['badge', 'mural'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
  },
};
