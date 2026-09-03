import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsDefined } from 'class-validator';

export class UpdateItemCotadoDto {
  @ApiProperty({ description: 'Se o item cotado foi autorizado', example: true })
  @IsDefined()
  @IsBoolean()
  autorizado!: boolean;
}
