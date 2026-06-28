-- MySQL dump 10.13  Distrib 9.7.1, for macos26.4 (arm64)
--
-- Host: localhost    Database: goodjob_crm
-- ------------------------------------------------------
-- Server version	9.7.1

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Current Database: `goodjob_crm`
--

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `goodjob_crm` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;

USE `goodjob_crm`;

--
-- Table structure for table `customers`
--

DROP TABLE IF EXISTS `customers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customers` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `company` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `country` varchar(80) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `contact` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `owner_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `team_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `stage` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `amount` decimal(14,2) DEFAULT '0.00',
  `health` int DEFAULT '0',
  `next_reminder` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `wecom_bound` tinyint(1) DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_customers_owner` (`owner_id`),
  KEY `idx_customers_team` (`team_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `customers`
--

LOCK TABLES `customers` WRITE;
/*!40000 ALTER TABLE `customers` DISABLE KEYS */;
INSERT INTO `customers` VALUES ('c1','Nordic Tools AB','瑞典','Emma','u_sales_shirley','europe','已报价',36000.00,58,'已逾期',1,'2026-06-26 16:08:07'),('c2','Atlas Home Inc','美国','Daniel','u_sales_shirley','europe','样品',22000.00,82,'今天 16:00',1,'2026-06-26 16:08:07'),('c3','Kanto Retail','日本','Sato','u_sales_mia','europe','谈判',48000.00,90,'明天 09:30',0,'2026-06-26 16:08:07'),('c4','Al Noor Trading','阿联酋','Hassan','u_sales_mia','europe','已报价',18000.00,45,'今天 10:30',1,'2026-06-26 16:08:07'),('c5','Evergreen GmbH','德国','Anna','u_sales_shirley','europe','成交',57000.00,95,'7 天后复购',1,'2026-06-26 16:08:07');
/*!40000 ALTER TABLE `customers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `deals`
--

DROP TABLE IF EXISTS `deals`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `deals` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `customer_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `stage` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount` decimal(14,2) DEFAULT '0.00',
  `owner_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `team_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `next_action` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `deals`
--

LOCK TABLES `deals` WRITE;
/*!40000 ALTER TABLE `deals` DISABLE KEYS */;
INSERT INTO `deals` VALUES ('d1','c1','Nordic Tools 电动工具年度采购','已报价',36000.00,'u_sales_shirley','europe','二次确认报价','2026-06-26 16:08:07'),('d2','c2','Atlas Home 家居样品测试','样品',22000.00,'u_sales_shirley','europe','确认样品反馈','2026-06-26 16:08:07'),('d3','c3','Kanto Retail 付款条款谈判','谈判',48000.00,'u_sales_mia','europe','主管参与账期谈判','2026-06-26 16:08:07'),('d4','c4','Al Noor LED 灯具报价','已报价',18000.00,'u_sales_mia','europe','更新汇率报价','2026-06-26 16:08:07'),('d5','c5','Evergreen GmbH 复购订单','成交',57000.00,'u_sales_shirley','europe','7 天后复购回访','2026-06-26 16:08:07');
/*!40000 ALTER TABLE `deals` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `exam_attempts`
--

DROP TABLE IF EXISTS `exam_attempts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `exam_attempts` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `exam_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `score` decimal(5,2) DEFAULT NULL,
  `passed` tinyint(1) DEFAULT NULL,
  `submitted_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `exam_attempts`
--

LOCK TABLES `exam_attempts` WRITE;
/*!40000 ALTER TABLE `exam_attempts` DISABLE KEYS */;
/*!40000 ALTER TABLE `exam_attempts` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `exams`
--

DROP TABLE IF EXISTS `exams`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `exams` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `category` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pass_rate` decimal(5,2) DEFAULT NULL,
  `question_count` int DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `exams`
--

LOCK TABLES `exams` WRITE;
/*!40000 ALTER TABLE `exams` DISABLE KEYS */;
INSERT INTO `exams` VALUES ('e1','LED 灯具基础','产品知识','published',72.00,25),('e2','认证资料专项','认证资料','draft',64.00,30),('e3','报价规则进阶','报价规则','scheduled',83.00,20);
/*!40000 ALTER TABLE `exams` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `import_export_jobs`
--

DROP TABLE IF EXISTS `import_export_jobs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `import_export_jobs` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `rows_count` int DEFAULT '0',
  `status` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `operator_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `import_export_jobs`
--

LOCK TABLES `import_export_jobs` WRITE;
/*!40000 ALTER TABLE `import_export_jobs` DISABLE KEYS */;
INSERT INTO `import_export_jobs` VALUES ('io1','2026 春季展会客户','import',1286,'done','u_admin','今天 09:12'),('io2','欧洲 A 级客户','export',184,'review','u_sales_shirley','今天 08:40');
/*!40000 ALTER TABLE `import_export_jobs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `knowledge_assets`
--

DROP TABLE IF EXISTS `knowledge_assets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `knowledge_assets` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `category` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `owner_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `version` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `knowledge_assets`
--

LOCK TABLES `knowledge_assets` WRITE;
/*!40000 ALTER TABLE `knowledge_assets` DISABLE KEYS */;
INSERT INTO `knowledge_assets` VALUES ('k1','LED 灯具参数手册 V3','产品知识','published','u_sales_mia','v3','2026-06-26 16:08:07'),('k2','欧洲报价模板','报价规则','review','u_sales_mia','v2','2026-06-26 16:08:07'),('k3','CE 证书客户解释话术','认证资料','published','u_sales_shirley','v1','2026-06-26 16:08:07');
/*!40000 ALTER TABLE `knowledge_assets` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `ocr_jobs`
--

DROP TABLE IF EXISTS `ocr_jobs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ocr_jobs` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `confidence` decimal(5,2) DEFAULT NULL,
  `fields_json` json DEFAULT NULL,
  `created_by` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `ocr_jobs`
--

LOCK TABLES `ocr_jobs` WRITE;
/*!40000 ALTER TABLE `ocr_jobs` DISABLE KEYS */;
INSERT INTO `ocr_jobs` VALUES ('ocr1','recognized',94.00,'{\"city\": \"Berlin\", \"email\": \"james.mueller@northstar-light.de\", \"phone\": \"+49 30 8842 1290\", \"title\": \"Purchasing Manager\", \"wechat\": \"james_light_de\", \"company\": \"NorthStar Lighting GmbH\", \"contact\": \"James Müller\", \"country\": \"德国\", \"whatsapp\": \"+49 151 2388 9012\"}',NULL,'2026-06-26 16:08:07');
/*!40000 ALTER TABLE `ocr_jobs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `reminders`
--

DROP TABLE IF EXISTS `reminders`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `reminders` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `rule_text` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `due_at` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `owner_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `team_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `channel` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `reminders`
--

LOCK TABLES `reminders` WRITE;
/*!40000 ALTER TABLE `reminders` DISABLE KEYS */;
INSERT INTO `reminders` VALUES ('r1','报价后 3 天未回复','A 级客户报价后 3 天提醒','今天 09:45','u_sales_shirley','europe','企业微信','pending'),('r2','样品签收后待反馈','签收后 3 天提醒','今天 16:00','u_sales_shirley','europe','站内','pending'),('r3','A 级客户 14 天未联系','高价值客户长期未触达','本周五','u_manager_alex','europe','邮件','sent');
/*!40000 ALTER TABLE `reminders` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `todos`
--

DROP TABLE IF EXISTS `todos`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `todos` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `priority` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `due_at` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `owner_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `team_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `related` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `done` tinyint(1) DEFAULT '0',
  `status` varchar(24) COLLATE utf8mb4_unicode_ci DEFAULT 'pending',
  `impact_amount` decimal(14,2) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `todos`
--

LOCK TABLES `todos` WRITE;
/*!40000 ALTER TABLE `todos` DISABLE KEYS */;
INSERT INTO `todos` VALUES ('t_1782490087986','MySQL落库验证-000807','other','normal','2026-06-27 00:08','u_sales_shirley','europe','MySQL验证',0,NULL),('t1','补发 Nordic Tools AB 的 CE 证书与新版交期说明','customer','high','今天 09:45','u_sales_shirley','europe','Nordic Tools AB',0,36000.00),('t2','审核欧洲报价模板并同步到资料库','knowledge','medium','今天 11:30','u_sales_mia','europe','报价规则',0,NULL),('t3','给中东组推送认证资料专项补考提醒','exam','normal','今天 15:00','u_manager_alex','europe','在线考试',0,NULL),('t4','复核 OCR 名片识别结果并同步 8 条展会线索','ocr','normal','今天 16:20','u_sales_shirley','europe','OCR 线索',0,NULL),('t5','确认 Atlas Home Inc 样品签收状态','customer','normal','09:12','u_sales_shirley','europe','Atlas Home Inc',1,NULL);
/*!40000 ALTER TABLE `todos` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(180) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role` enum('sales','manager','admin') COLLATE utf8mb4_unicode_ci NOT NULL,
  `team_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `avatar` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('active','disabled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES ('u_admin','Admin','admin@goodjob.com','goodjob123','admin','all','AD','active','2026-06-26 16:08:07'),('u_manager_alex','Alex','alex@goodjob.com','goodjob123','manager','europe','AL','active','2026-06-26 16:08:07'),('u_sales_mia','Mia','mia@goodjob.com','goodjob123','sales','europe','MI','active','2026-06-26 16:08:07'),('u_sales_shirley','Shirley','shirley@goodjob.com','goodjob123','sales','europe','SH','active','2026-06-26 16:08:07');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `wecom_messages`
--

DROP TABLE IF EXISTS `wecom_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `wecom_messages` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `customer_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `summary` text COLLATE utf8mb4_unicode_ci,
  `owner_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `team_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `wecom_messages`
--

LOCK TABLES `wecom_messages` WRITE;
/*!40000 ALTER TABLE `wecom_messages` DISABLE KEYS */;
INSERT INTO `wecom_messages` VALUES ('w1','c1','客户关注 CE 证书与交期，已承诺今日补发新版参数。','u_sales_shirley','europe','archived','2026-06-26 16:08:07'),('w2','c2','样品测试反馈预计明天下午给出，需要提醒客户确认复购时间。','u_sales_shirley','europe','pending','2026-06-26 16:08:07');
/*!40000 ALTER TABLE `wecom_messages` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-06-27  0:09:39
