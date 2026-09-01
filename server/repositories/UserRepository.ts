import { prisma } from '../db/prisma.js';

export interface UserEntity {
  id: number;
  email: string;
  name: string;
  role: string;
  phone: string | null;
  password_hash: string;
  twoFactorActive: boolean;
  supportPinConfigured: boolean;
  two_factor_secret?: string | null;
  ssh_keys?: string | null;
}

export class UserRepository {
  
  static async findById(id: number): Promise<UserEntity | null> {
    const user = await prisma.accounts.findUnique({
      where: { id }
    });
    
    if (!user) return null;
    
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone,
      password_hash: user.password_hash,
      twoFactorActive: Boolean(user.two_factor_active),
      supportPinConfigured: Boolean(user.support_pin),
      two_factor_secret: user.tfa_secret || null,
      ssh_keys: user.ssh_keys || null,
    };
  }

  static async getTotpSecret(email: string): Promise<string | null> {
    const clean = email.toLowerCase().trim();
    try {
      const totpRecord = await prisma.totp_secrets.findUnique({
        where: { account_email: clean }
      });
      if (totpRecord?.secret) return totpRecord.secret;
    } catch {
      // fallback
    }
    const user = await this.findUserByEmail(clean);
    return user?.two_factor_secret || null;
  }

  static async findUserByEmail(email: string): Promise<UserEntity | null> {
    const clean = email.toLowerCase().trim();
    const user = await prisma.accounts.findUnique({
      where: { email: clean }
    });
    
    if (!user) return null;
    
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone,
      password_hash: user.password_hash,
      twoFactorActive: Boolean(user.two_factor_active),
      supportPinConfigured: Boolean(user.support_pin),
      two_factor_secret: user.tfa_secret || null,
      ssh_keys: user.ssh_keys || null,
    };
  }
}
