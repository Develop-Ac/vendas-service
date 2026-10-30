import type { Catalogo } from './common/avisos/avisos-client';

/**
 * O QUE O VENDAS-SERVICE EMITE — catálogo sincronizado no boot com o
 * avisos-service (regra nasce inativa; liga-se em /avisos/config).
 *
 * Régua: canal `desktop` (balão do Windows na Estação) só no que exige ação do
 * vendedor AGORA. O resto fica no sino/mural. Alvo padrão = usuário (o
 * vendedor dono da carteira, resolvido por sis_usuarios.vendas_rep_codigo).
 * Fila, resgate e motivo apontam para a tela de Orçamentos com o bloco de
 * tarefas aberto (?tarefas=hoje|sem-desfecho) — a Estação está fora de uso
 * nesta fase. O emissor também manda o link na emissão, porque regra já
 * gravada no avisos-service não é sobrescrita pelo catálogo.
 */
export const CATALOGO_VENDAS: Catalogo = {
  'fila.dia': {
    descricao: 'Fila do dia gerada para o vendedor (carga diária).',
    titulo: 'Fila de hoje: {total} cliente(s)',
    corpo: '{resgates} resgate(s) · {escaladas} escalada(s)',
    link: '/vendas/orcamento?tarefas=hoje',
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
    link: '/vendas/orcamento?tarefas=hoje',
    canais: ['badge', 'mural', 'desktop'],
    prioridade: 'alta',
    alvo: { tipo: 'usuario' },
  },
  'resgate.sla': {
    descricao: 'Cliente curva A em risco sem contato dentro do SLA de 48 h.',
    titulo: 'Resgate atrasado: {cliente}',
    corpo: 'Curva A sem contato há {horas} h · SLA {sla} h',
    link: '/vendas/orcamento?tarefas=hoje',
    canais: ['badge', 'mural', 'desktop'],
    prioridade: 'alta',
    alvo: { tipo: 'usuario' },
  },
  'orcamento.bloqueado': {
    descricao: 'Comparativo do Celta divergiu: o vendedor ficou com orcamentoBloqueado.',
    titulo: 'Orçamento {numero} divergente — {vendedor} bloqueado',
    corpo: 'Celta {celta} · {cliente}\n{diferencas}',
    canais: ['modal'],
    prioridade: 'alta',
    alvo: { tipo: 'setor', valor: 'Gerência' },
    acao_url_template: 'http://sistema-service.acacessorios.local/orcamentoBloqueado/{rep}',
    acao_rotulo: 'Liberar vendedor',
    // Não existe "não liberar": ou libera agora, ou fecha o diálogo e o aviso fica pendente.
    acao_permite_nao: false,
  },
  'b2b.novo': {
    descricao: 'Pedido novo do portal B2B para o vendedor responsável pelo cliente.',
    titulo: 'Novo pedido B2B: {cliente}',
    corpo: '{itens} item(ns){valor}',
    link: '/vendas/orcamento',
    canais: ['badge'],
    prioridade: 'alta',
    alvo: { tipo: 'usuario' },
    // agrupar = chave por pedido: é o que permite tirar o aviso quando o vendedor assume
    agrupar: true,
  },
  'b2b.sem_responsavel': {
    descricao: 'Pedido do portal B2B sem vendedor: empresa sem vínculo com o Celta ou cliente sem carteira.',
    titulo: 'Pedido B2B sem vendedor: {empresa}',
    corpo: '{motivo}',
    link: '/vendas/b2b',
    canais: ['badge'],
    prioridade: 'alta',
    alvo: { tipo: 'usuario' },
    agrupar: true,
  },
  'orcamento.aprovacao': {
    descricao: 'Vendedor mandou orçamento acima do desconto máximo para aprovação da gerência.',
    titulo: 'Orçamento {numero} aguardando aprovação',
    corpo: '{vendedor} · {cliente} · {total}',
    link: '/vendas/orcamento/{id}',
    canais: ['badge', 'mural', 'desktop'],
    prioridade: 'alta',
    alvo: { tipo: 'usuario' },
    // agrupar = aviso com chave por orçamento: é o que permite tirá-lo de todos quando alguém aprova
    agrupar: true,
  },
  'orcamento.devolvido': {
    descricao: 'Gerência devolveu ao vendedor o orçamento que estava em aprovação, com o motivo.',
    titulo: 'Orçamento {numero} devolvido pela gerência',
    corpo: '{gerente}: {motivo}',
    link: '/vendas/orcamento/{id}',
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
  // Nasce inativa como todas: ligar em /avisos/config após o deploy.
  'orcamento.retorno': {
    descricao: 'Cliente adiou e o orçamento ADIADO chegou hoje à data de retorno combinada.',
    titulo: 'Retorno agendado: {cliente}',
    corpo: 'Orçamento {numero} · {total} · adiado para hoje',
    link: '/vendas/orcamento/{id}',
    canais: ['badge', 'desktop'],
    prioridade: 'alta',
    alvo: { tipo: 'usuario' },
    // agrupar = chave por orçamento: é o que permite tirar o aviso quando ele sai de ADIADO ou é reagendado
    agrupar: true,
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
  // Chave nova (e não a de cima): regra já gravada no avisos-service não é
  // sobrescrita pelo catálogo, e a antiga tem templates por orçamento.
  'orcamento.sem_desfecho.resumo': {
    descricao: 'Resumo diário: orçamentos com 7 dias sem venda esperando o motivo do vendedor.',
    titulo: '{total} orçamento(s) sem motivo',
    corpo: '{valor} orçados sem venda · informe o motivo (1 toque cada)',
    link: '/vendas/orcamento?tarefas=sem-desfecho',
    canais: ['badge'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
    agrupar: true,
  },
  'fila.escalada.supervisor': {
    descricao: 'Supervisão: tarefas da fila escaladas hoje (prazo de contato estourado), por vendedor.',
    titulo: '{total} tarefa(s) escalada(s) hoje',
    corpo: '{vendedores}',
    link: '/vendas/supervisao-atacado',
    canais: ['badge', 'mural'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
    agrupar: true,
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
  'produtos.dia': {
    descricao: 'Produtos do dia: lotes de oportunidade para o supervisor do atacado empurrar hoje.',
    titulo: 'Produtos do dia: {total} item(ns) para empurrar',
    corpo: 'Bolsa potencial de {bolsa} · {fora} lote(s) de fora por estoque',
    link: '/vendas/produtos-do-dia',
    canais: ['badge', 'mural'],
    prioridade: 'normal',
    alvo: { tipo: 'usuario' },
    cooldown_min: 60,
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
