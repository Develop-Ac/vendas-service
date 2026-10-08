import { Global, Module } from '@nestjs/common';
import { ComprasApiService } from './compras-api.service';

@Global()
@Module({
  providers: [ComprasApiService],
  exports: [ComprasApiService],
})
export class ComprasApiModule {}
