-- CreateEnum
CREATE TYPE "AppAccessMode" AS ENUM ('ALL_MEMBERS', 'RESTRICTED');

-- AlterTable
ALTER TABLE "OrgAppEntitlement" ADD COLUMN     "accessMode" "AppAccessMode" NOT NULL DEFAULT 'ALL_MEMBERS';
