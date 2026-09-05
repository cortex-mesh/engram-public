-- Authorization-critical role columns become Postgres enums (audit #12).
-- Converted IN PLACE with a cast so existing role values are preserved
-- (Prisma's auto-generated diff would DROP+ADD the column and lose data).

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'ADMIN', 'SUPERADMIN');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- AlterTable: User.role String -> PlatformRole (drop text default, cast, re-add)
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "PlatformRole" USING ("role"::"PlatformRole");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER';

-- AlterTable: OrgMember.role String -> OrgRole
ALTER TABLE "OrgMember" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "OrgMember" ALTER COLUMN "role" TYPE "OrgRole" USING ("role"::"OrgRole");
ALTER TABLE "OrgMember" ALTER COLUMN "role" SET DEFAULT 'MEMBER';

-- AlterTable: OrgInvite.role String -> OrgRole
ALTER TABLE "OrgInvite" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "OrgInvite" ALTER COLUMN "role" TYPE "OrgRole" USING ("role"::"OrgRole");
ALTER TABLE "OrgInvite" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
