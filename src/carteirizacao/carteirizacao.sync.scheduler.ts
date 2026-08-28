import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CarteirizacaoService } from './carteirizacao.service';
import { FilaService } from './fila.service';
import { ResgateService } from './resgate.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

/**
 * Carga diária automática da carteirização: reconcilia o overlay com o ERP
 * (fonte da verdade), aplicando trocas de vendedor, novos clientes e marcando
 * para revisão quem saiu do atacado. Horário configurável por
 * `CARTEIRIZACAO_SYNC_CRON` (padrão: 05:00 todos os dias).
 */
@Injectable()
export class CarteirizacaoSyncScheduler {
  private readonly logger = new Logger(CarteirizacaoSyncScheduler.name);

  constructor(
    private readonly service: CarteirizacaoService,
    private readonly fila: FilaService,
    private readonly resgate: ResgateService,
    private readonly whatsapp: WhatsappService,
  ) {}

  @Cron(process.env.CARTEIRIZACAO_SYNC_CRON ?? '0 5 * * *', {
    name: 'carteirizacao-sync',
    timeZone: 'America/Sao_Paulo',
  })
  async cargaDiaria() {
    this.logger.log('Iniciando carga diária da carteirização (ERP → overlay)...');
    try {
      const r = await this.service.sincronizar({
        usuario_nome: 'SISTEMA (carga diária)',
      });
      this.logger.log(
        `Carga concluída (lote ${('lote_id' in r && r.lote_id) || '-'}): ` +
          `${r.novos} novos, ${r.alterados} alterados, ${r.sem_vendedor} sem vendedor, ` +
          `${r.revisao} p/ revisão.`,
      );
    } catch (e) {
      this.logger.error(
        `Falha na carga diária da carteirização: ${(e as Error).message}`,
        (e as Error).stack,
      );
    }

    // Contatos do sensor WhatsApp na sequência da carga: cliente novo (ou fone
    // atualizado) no ERP entra em ven_wa_contato e adota o histórico pendente
    // do número — sem esperar seed manual.
    try {
      const s = await this.whatsapp.seedContatos();
      this.logger.log(
        `Contatos WhatsApp: ${s.inseridas} chaves novas, ${s.mensagens_religadas} mensagens religadas.`,
      );
    } catch (e) {
      this.logger.error(`Falha na semente de contatos WhatsApp: ${(e as Error).message}`);
    }

    // Fila do dia na sequência da carga: a régua trabalha sobre a carteira
    // recém-reconciliada. Falha aqui não derruba a carga — a geração também
    // roda em POST /carteirizacao/fila/gerar.
    try {
      const f = await this.fila.gerar();
      this.logger.log(
        `Fila do dia: ${f.geradas} novas (${f.resgates} resgates), ` +
          `${f.canceladas} canceladas, ${f.ja_em_andamento} já em andamento.`,
      );
    } catch (e) {
      this.logger.error(`Falha na geração da fila do dia: ${(e as Error).message}`);
    }

    // Esteira de resgate na sequência: abre episódios de quem entrou em risco
    // e avança/fecha os existentes pelos sinais do dia.
    try {
      const r = await this.resgate.reconciliar();
      this.logger.log(`Esteira de resgate: ${r.novos} episódios novos, ${r.abertos} em andamento.`);
    } catch (e) {
      this.logger.error(`Falha na esteira de resgate: ${(e as Error).message}`);
    }
  }
}
