import type { QuadranteCliente } from '../carteirizacao.service';
export type StatusCliente = 'ATIVO' | 'INATIVO' | 'SEM_CARTEIRA' | 'DISPONIVEL';

export interface ListarClientesQuery {
  page?: number;
  pageSize?: number;
  status?: StatusCliente;
  rep_codigo?: number;
  semVendedor?: boolean;
  uf?: string;
  busca?: string;
  faturamentoMin?: number;
  faturamentoMax?: number;
  altoFaturamento?: boolean;
  queda?: boolean;
  novo?: boolean;
  risco?: boolean;
  revisao?: boolean;
  curvaAbc?: 'A' | 'B' | 'C';
  quadrante?: QuadranteCliente;
  scoreFaixa?: 'A' | 'B' | 'C' | 'D';
  ordenarPor?: string;
  ordem?: 'asc' | 'desc';
  janelaDias?: number;
}

export class AtribuirDto {
  cli_codigo: number;
  rep_codigo: number;
  motivo?: string;
  canal?: string;
  observacao?: string;
  usuario_id?: string;
  usuario_nome?: string;
}

export class AtribuirLoteDto {
  cli_codigos: number[];
  rep_codigo: number;
  motivo?: string;
  usuario_id?: string;
  usuario_nome?: string;
}

export class TransferirDto {
  rep_origem: number;
  rep_destino: number;
  cli_codigos?: number[]; // se vazio, transfere toda a carteira do rep_origem
  motivo?: string;
  usuario_id?: string;
  usuario_nome?: string;
}

export class RemoverDto {
  motivo?: string;
  usuario_id?: string;
  usuario_nome?: string;
}

/**
 * Desfecho de um orçamento sem venda — a única digitação nova do vendedor na
 * fase 1 (1 toque, 6 motivos). Os dados do orçamento vêm da própria fila
 * (cópia do ERP na hora do clique); o motivo é validado no FilaService.
 */
export class DesfechoOrcamentoDto {
  motivo: string; // PRECO | PRAZO_FRETE | SEM_ESTOQUE | CONCORRENTE | CLIENTE_ADIOU | CREDITO_BLOQUEADO
  cli_codigo: number;
  cli_nome?: string;
  rep_codigo?: number;
  rep_nome?: string;
  emissao?: string;
  total?: number;
  observacao?: string;
  usuario_id?: string;
  usuario_nome?: string;
}

export class SeedDto {
  // 'rep_codigo' (default) = só cadastro; 'hibrido' = rep_codigo + vendedor dominante; 'vendas' = só vendas
  estrategia?: 'rep_codigo' | 'hibrido' | 'vendas';
  dryRun?: boolean;
}

export class SincronizarDto {
  // se true, apenas conta as diferenças sem gravar
  dryRun?: boolean;
  usuario_id?: string;
  usuario_nome?: string;
}

export class ConfirmarExclusaoDto {
  motivo?: string;
  usuario_id?: string;
  usuario_nome?: string;
}

export class ConfigVendedorDto {
  rep_nome?: string;
  capacidade_max?: number | null;
  canal?: string | null;
  ativo?: boolean;
  meta_faturamento?: number | null;
  observacao?: string | null;
}

export class MetaVendedorDto {
  ano: number;
  mes: number;
  valor_meta: number;
  rep_nome?: string;
  observacao?: string;
  usuario_id?: string;
}

export class RedistribuirDto {
  // vendedores que participam do balanceamento (origem e destino do pool)
  rep_codigos: number[];
  // incluir também os clientes "sem carteira" no pool a distribuir
  incluirSemCarteira?: boolean;
  // critério de balanceamento
  criterio?: 'quantidade' | 'faturamento';
  // respeitar capacidade_max configurada por vendedor
  respeitarCapacidade?: boolean;
  dryRun?: boolean;
  motivo?: string;
  usuario_id?: string;
  usuario_nome?: string;
}
