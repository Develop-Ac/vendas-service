export type StatusCliente = 'ATIVO' | 'INATIVO' | 'SEM_CARTEIRA';

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

export class SeedDto {
  // 'rep_codigo' (default) = só cadastro; 'hibrido' = rep_codigo + vendedor dominante; 'vendas' = só vendas
  estrategia?: 'rep_codigo' | 'hibrido' | 'vendas';
  dryRun?: boolean;
}
