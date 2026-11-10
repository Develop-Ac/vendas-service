import { CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

/**
 * Só aceita chamada que passou pelo proxy da intranet: header `x-app-token` igual ao
 * APP_TOKEN deste serviço (o proxy manda o VENDAS_SERVICE_TOKEN). Sem isso o
 * `x-user-id` seria de quem chamasse o serviço direto. APP_TOKEN vazio = tudo recusado.
 */
export class SoPeloProxy implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const esperado = process.env.APP_TOKEN;
    const token = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers['x-app-token'];
    if (!esperado || token !== esperado) throw new ForbiddenException('Esta rota só responde pela intranet.');
    return true;
  }
}
