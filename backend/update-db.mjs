import mysql from "mysql2/promise";

const dbUrl = process.env.DATABASE_URL || "mysql://goodjob:change_me@127.0.0.1:3306/goodjob_crm";

async function updateDatabase() {
  console.log("连接数据库...");
  const pool = mysql.createPool(dbUrl);

  try {
    console.log("开始添加字段...");

    // 添加 binding_mode
    try {
      await pool.query("ALTER TABLE whatsapp_bindings ADD COLUMN binding_mode VARCHAR(20) DEFAULT 'manual'");
      console.log("✓ 添加 binding_mode");
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log("- binding_mode 已存在");
      } else {
        throw e;
      }
    }

    // 添加 user_id
    try {
      await pool.query("ALTER TABLE whatsapp_bindings ADD COLUMN user_id VARCHAR(64) DEFAULT ''");
      console.log("✓ 添加 user_id");
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log("- user_id 已存在");
      } else {
        throw e;
      }
    }

    // 添加 session_data
    try {
      await pool.query("ALTER TABLE whatsapp_bindings ADD COLUMN session_data TEXT");
      console.log("✓ 添加 session_data");
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log("- session_data 已存在");
      } else {
        throw e;
      }
    }

    // 添加 twilio_phone_number
    try {
      await pool.query("ALTER TABLE whatsapp_bindings ADD COLUMN twilio_phone_number VARCHAR(20) DEFAULT ''");
      console.log("✓ 添加 twilio_phone_number");
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log("- twilio_phone_number 已存在");
      } else {
        throw e;
      }
    }

    // 添加 connection_status
    try {
      await pool.query("ALTER TABLE whatsapp_bindings ADD COLUMN connection_status VARCHAR(20) DEFAULT 'disconnected'");
      console.log("✓ 添加 connection_status");
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log("- connection_status 已存在");
      } else {
        throw e;
      }
    }

    // 添加 last_connected_at
    try {
      await pool.query("ALTER TABLE whatsapp_bindings ADD COLUMN last_connected_at DATETIME NULL");
      console.log("✓ 添加 last_connected_at");
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log("- last_connected_at 已存在");
      } else {
        throw e;
      }
    }

    // 添加索引
    try {
      await pool.query("ALTER TABLE whatsapp_bindings ADD INDEX idx_whatsapp_bindings_user(user_id)");
      console.log("✓ 添加索引 idx_whatsapp_bindings_user");
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log("- 索引已存在");
      } else {
        throw e;
      }
    }

    console.log("\n数据库更新完成！");

    // 显示表结构
    const [rows] = await pool.query("DESCRIBE whatsapp_bindings");
    console.log("\n当前表结构:");
    console.table(rows);

    await pool.end();
  } catch (error) {
    console.error("错误:", error.message);
    process.exit(1);
  }
}

updateDatabase();
