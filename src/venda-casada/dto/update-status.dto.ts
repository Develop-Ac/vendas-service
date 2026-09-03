import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateStatusDto {
  @ApiProperty({ description: 'Novo status da encomenda', example: 'Cotado' })
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  status!: string;
}
