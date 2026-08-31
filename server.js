const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session support - 24h expiry, fixes 1-min logout bug
app.use(session({
  secret: 'online-exam-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000, path: '/' }
}));

// Debug route
app.get('/debug-session', (req, res) => {
  const session = req.session;
  res.json({
    userId: session.userId,
    username: session.username,
    role: session.role,
    headers: req.headers
  });
});

// Database setup
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'database.db');
if (path.dirname(DATABASE_PATH) !== '.') {
  require('fs').mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
}
const db = new sqlite3.Database(DATABASE_PATH, (err) => {
  if (err) console.error('Database error:', err);
  else console.log('Connected to database: ' + DATABASE_PATH);
});

// Create tables
db.serialize(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      full_name TEXT,
      course TEXT,
      year_level TEXT,
      set_group TEXT,
      subjects TEXT,
      role TEXT DEFAULT 'student',
      failed_attempts INTEGER DEFAULT 0,
      is_locked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      question TEXT,
      option_a TEXT,
      option_b TEXT,
      option_c TEXT,
      option_d TEXT,
      correct_answer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      subject TEXT,
      semester TEXT,
      period TEXT,
      instruction TEXT,
      duration INTEGER,
      instructor TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS exam_questions (
      exam_id INTEGER,
      question_id INTEGER,
      PRIMARY KEY (exam_id, question_id)
    );
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER,
      exam_id INTEGER,
      score INTEGER,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      code TEXT,
      schedule DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // migration for existing DB without new columns
  db.run("ALTER TABLE subjects ADD COLUMN code TEXT", () => {});
  db.run("ALTER TABLE users ADD COLUMN full_name TEXT", () => {});
  db.run("ALTER TABLE users ADD COLUMN course TEXT", () => {});
  db.run("ALTER TABLE users ADD COLUMN year_level TEXT", () => {});
  db.run("ALTER TABLE users ADD COLUMN set_group TEXT", () => {});
  db.run("ALTER TABLE users ADD COLUMN subjects TEXT", () => {});
  db.run("ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE users ADD COLUMN is_locked INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE exams ADD COLUMN semester TEXT", () => {});
  db.run("ALTER TABLE exams ADD COLUMN period TEXT", () => {});
    db.run("ALTER TABLE exams ADD COLUMN instruction TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN theme TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN referrer_id INTEGER", () => {});
    db.run("ALTER TABLE users ADD COLUMN signup_token TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN is_super INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE subjects ADD COLUMN created_by INTEGER", () => {});
    db.run("ALTER TABLE questions ADD COLUMN created_by INTEGER", () => {});
    db.run("ALTER TABLE exams ADD COLUMN created_by INTEGER", () => {});
  });

// Bootstrap default admin on a fresh/empty database
db.serialize(() => {
  db.get("SELECT COUNT(*) AS c FROM users WHERE role='admin'", [], (err, row) => {
    if (!err && row && row.c === 0) {
      db.run("INSERT INTO users (username, password, full_name, role, is_super) VALUES (?, ?, ?, 'admin', 1)",
        ['admin', 'admin123', 'System Administrator'], function(err2) {
          if (err2) console.error('Admin bootstrap error:', err2);
          else console.log('Created default admin account (admin/admin123)');
        });
    }
  });
});

// Seed/backfill multi-admin columns (idempotent)
db.serialize(() => {
  // Make account id=1 the super admin
  db.run("UPDATE users SET is_super=1, role='admin' WHERE id=1");
  // Existing content owned by super admin (id=1)
  db.run("UPDATE subjects SET created_by=1 WHERE created_by IS NULL");
  db.run("UPDATE questions SET created_by=1 WHERE created_by IS NULL");
  db.run("UPDATE exams SET created_by=1 WHERE created_by IS NULL");
  // Ensure admin accounts have a signup token
  db.all("SELECT id, username, signup_token FROM users WHERE role='admin'", [], (err, admins) => {
    (admins || []).forEach(a => {
      if (!a.signup_token) {
        const token = require('crypto').randomBytes(12).toString('hex');
        db.run("UPDATE users SET signup_token=? WHERE id=?", [token, a.id]);
      }
    });
  });
});

// ===== AUTH MIDDLEWARE =====
function isLoggedIn(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).send('Admin access required');
}

// Multi-admin helpers
function isSuperAdmin(req) {
  return req.session && String(req.session.userId) === '1';
}
// SQL suffix + params to scope rows owned by an admin (super sees all)
function scopeClause(req, col, alias) {
  const a = alias ? alias + '.' : '';
  if (isSuperAdmin(req)) return { sql: '', params: [] };
  return { sql: ` AND ${a}${col} = ? `, params: [req.session.userId] };
}
// Full list of subjects visible to current admin
function getAdminSubjects(req, cb) {
  const s = scopeClause(req, 'created_by');
  db.all('SELECT * FROM subjects WHERE 1=1' + s.sql + ' ORDER BY name', s.params, cb);
}
// Get admin row by signup token (or super admin if token missing/generic)
function findByToken(token, cb) {
  if (!token) return cb(null, null);
  db.get('SELECT * FROM users WHERE role="admin" AND signup_token=?', [token], cb);
}

// ===== ROUTES =====

// Home
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    if (req.session.role === 'admin') res.redirect('/admin');
    else res.redirect('/student');
  } else {
    res.redirect('/login');
  }
});

// ===== AUTH ROUTES =====
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.redirect('/login?error=' + encodeURIComponent('Username and password required'));
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) return res.redirect('/login?error=' + encodeURIComponent('Database error'));
    if (!user) return res.redirect('/login?error=' + encodeURIComponent('Invalid credentials, please try again'));
    if (user.is_locked) {
      return res.redirect('/login?error=' + encodeURIComponent('Account locked after 3 failed attempts') + '&warning=' + encodeURIComponent('Contact admin to unlock/reset your account'));
    }
    if (user.password !== password) {
      const attempts = (user.failed_attempts || 0) + 1;
      if (attempts >= 3) {
        db.run('UPDATE users SET failed_attempts=?, is_locked=1 WHERE id=?', [attempts, user.id], () => {
          return res.redirect('/login?error=' + encodeURIComponent('Account locked after 3 failed attempts') + '&warning=' + encodeURIComponent('Contact admin to reset — Attempt ' + attempts + '/3'));
        });
      } else {
        db.run('UPDATE users SET failed_attempts=? WHERE id=?', [attempts, user.id], () => {
          return res.redirect('/login?error=' + encodeURIComponent('Invalid credentials, please try again') + '&warning=' + encodeURIComponent('Attempt ' + attempts + '/3 — after 3, account will lock'));
        });
      }
      return;
    }
    // success — reset attempts
    db.run('UPDATE users SET failed_attempts=0, is_locked=0 WHERE id=?', [user.id], () => {
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.full_name = user.full_name;
      req.session.course = user.course;
      req.session.year_level = user.year_level;
      req.session.set_group = user.set_group;
      req.session.referrer_id = user.referrer_id || null;
      try { req.session.subjects = user.subjects ? JSON.parse(user.subjects) : []; } catch(e){ req.session.subjects = []; }
      req.session.role = user.role;
      req.session.theme = user.theme || 'system';
      res.cookie('theme', user.theme || 'system', { maxAge: 31536000000, path: '/' });
      req.session.save(() => res.redirect('/'));
    });
  });
});

app.get('/signup', (req, res) => {
  const ref = (req.query.ref || '').trim();
  findByToken(ref, (err, admin) => {
    if (err) return res.render('signup', { subjects: [], refAdmin: null, ref: '', user: null });
    const refAdmin = admin || null;
    const refId = refAdmin ? refAdmin.id : null;
    // Show only the referring admin's subjects, plus (if valid admin) their subjects only.
    db.all('SELECT * FROM subjects WHERE created_by = ? ORDER BY name', [refId || 1], (err2, subjects) => {
      res.render('signup', { subjects: subjects || [], refAdmin, ref: ref, user: req.session });
    });
  });
});

app.post('/signup', (req, res) => {
  const { username, password, full_name, course, year_level, set_group, ref } = req.body;
  let selectedSubjects = req.body.subjects;
  if (!selectedSubjects) selectedSubjects = [];
  else if (!Array.isArray(selectedSubjects)) selectedSubjects = [selectedSubjects];
  if (!username || !password || !full_name || !course || !year_level || !set_group) return res.redirect('/signup' + (ref ? '?ref=' + ref + '&' : '?') + 'error=' + encodeURIComponent('All fields required'));
  if (!selectedSubjects.length) return res.redirect('/signup' + (ref ? '?ref=' + ref + '&' : '?') + 'error=' + encodeURIComponent('Select at least one subject'));
  const subjectsJson = JSON.stringify(selectedSubjects);
  // Determine referring admin from token
  const confirmSignup = (referrerId) => {
    db.run('INSERT INTO users (username, password, full_name, course, year_level, set_group, subjects, role, referrer_id) VALUES (?, ?, ?, ?, ?, ?, ?, "student", ?)', [username, password, full_name.trim(), course.trim(), year_level, set_group, subjectsJson, referrerId], function(err) {
      if (err) return res.redirect('/signup' + (ref ? '?ref=' + ref + '&' : '?') + 'error=' + encodeURIComponent('Username already exists'));
      req.session.userId = this.lastID;
      req.session.username = username;
      req.session.full_name = full_name.trim();
      req.session.set_group = set_group;
      req.session.role = 'student';
      req.session.subjects = selectedSubjects;
      req.session.theme = 'system';
      req.session.referrer_id = referrerId;
      res.cookie('theme', 'system', { maxAge: 31536000000, path: '/' });
      req.session.save(() => res.redirect('/'));
    });
  };
  if (ref) {
    findByToken(ref, (err, admin) => {
      if (err || !admin || admin.role !== 'admin') return res.redirect('/signup?ref=' + ref + '&error=' + encodeURIComponent('Invalid signup link'));
      confirmSignup(admin.id);
    });
  } else {
    // No token -> register under the super admin (main admin)
    confirmSignup(1);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.clearCookie('theme', { path: '/' });
  res.redirect('/login');
});

// ===== ADMIN ROUTES =====

// Admin dashboard
app.get('/admin', isLoggedIn, isAdmin, (req, res) => {
  const qSc = scopeClause(req, 'created_by');
  const eSc = scopeClause(req, 'created_by', 'e');
  const superAdmin = isSuperAdmin(req);
  // Students scoped by referrer admin unless super
  const uSc = superAdmin ? { sql: '', params: [] } : { sql: ' AND referrer_id = ? ', params: [req.session.userId] };
  db.get('SELECT COUNT(*) as cnt FROM questions WHERE 1=1' + qSc.sql, qSc.params, (err, qRow) => {
    db.get('SELECT COUNT(*) as cnt FROM exams e WHERE 1=1' + eSc.sql, eSc.params, (err2, eRow) => {
      db.get("SELECT COUNT(*) as cnt FROM users WHERE role='student'" + uSc.sql, uSc.params, (err3, sRow) => {
        db.all('SELECT * FROM questions WHERE 1=1' + qSc.sql + ' ORDER BY created_at DESC', qSc.params, (err4, questions) => {
          if (err4) return res.status(500).send('Database error');
          getAdminSubjects(req, (err5, subjects) => {
            res.render('admin_dashboard', {
              questions,
              user: req.session,
              subjects: subjects || [],
              superAdmin,
              total_questions: qRow ? qRow.cnt : 0,
              total_exams: eRow ? eRow.cnt : 0,
              total_students: sRow ? sRow.cnt : 0
            });
          });
        });
      });
    });
  });
});

// Add question form - with dynamic subjects (scoped to admin)
app.get('/admin/questions/add', isLoggedIn, isAdmin, (req, res) => {
  getAdminSubjects(req, (err, subjects) => {
    if (err) subjects = [];
    res.render('add_question', { subjects: subjects || [], user: req.session });
  });
});

app.post('/admin/questions/add', isLoggedIn, isAdmin, (req, res) => {
  const { subject, question, option_a, option_b, option_c, option_d, correct_answer } = req.body;
  if (!['A','B','C','D'].includes((correct_answer||'').toUpperCase())) return res.redirect('/admin/questions/add?error=' + encodeURIComponent('Correct answer must be A, B, C, or D'));
  if (!subject || !question || !option_a || !option_b || !option_c || !option_d) return res.redirect('/admin/questions/add?error=' + encodeURIComponent('All fields required'));
  // Subject must belong to this admin (super sees all)
  const subjScope = scopeClause(req, 'created_by');
  db.get('SELECT COUNT(*) as cnt FROM subjects WHERE name = ?' + subjScope.sql, [subject].concat(subjScope.params), (errS, sRow) => {
    if (errS || !sRow || sRow.cnt === 0) return res.redirect('/admin/questions/add?error=' + encodeURIComponent('Invalid subject for your account'));
    db.run(
      'INSERT INTO questions (subject, question, option_a, option_b, option_c, option_d, correct_answer, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [subject, question, option_a, option_b, option_c, option_d, correct_answer.toUpperCase(), req.session.userId],
      (err) => {
        if (err) return res.redirect('/admin/questions/add?error=' + encodeURIComponent('Failed to add question'));
        res.redirect('/admin?success=' + encodeURIComponent('Question added to ' + subject));
      }
    );
  });
});

// Download CSV template
app.get('/admin/questions/template', isLoggedIn, isAdmin, (req, res) => {
  const csv = 'subject,question,option_a,option_b,option_c,option_d,correct_answer\n"Mathematics","What is 2+2?","3","4","5","6","B"\n"Science","What is H2O?","Oxygen","Water","Hydrogen","Helium","B"\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="questions_template.csv"');
  res.send(csv);
});

// Bulk upload CSV
app.post('/admin/questions/upload', isLoggedIn, isAdmin, upload.single('csv'), (req, res) => {
  if (!req.file) return res.redirect('/admin/questions/add?error=' + encodeURIComponent('No file uploaded'));
  try {
    const content = req.file.buffer.toString('utf8');
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    if (!records.length) return res.redirect('/admin/questions/add?error=' + encodeURIComponent('CSV is empty'));
    let inserted = 0;
    let errors = [];
    const stmt = db.prepare('INSERT INTO questions (subject, question, option_a, option_b, option_c, option_d, correct_answer, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let pending = records.length;
    if (pending === 0) return res.redirect('/admin/questions/add?warning=' + encodeURIComponent('No rows to import'));
    records.forEach((r, idx) => {
      const subject = (r.subject || r.Subject || '').trim();
      const question = (r.question || r.Question || '').trim();
      const option_a = (r.option_a || r.Option_A || '').trim();
      const option_b = (r.option_b || '').trim();
      const option_c = (r.option_c || '').trim();
      const option_d = (r.option_d || '').trim();
      const correct = (r.correct_answer || r.correct || r.Correct || '').trim().toUpperCase();
      if (!subject || !question || !option_a || !option_b || !option_c || !option_d || !['A','B','C','D'].includes(correct)) {
        errors.push('Row ' + (idx+2) + ' invalid');
        if (--pending === 0) finish();
        return;
      }
      stmt.run([subject, question, option_a, option_b, option_c, option_d, correct, req.session.userId], (err) => {
        if (!err) inserted++;
        else errors.push('Row ' + (idx+2) + ' failed');
        if (--pending === 0) finish();
      });
    });
    function finish(){
      stmt.finalize();
      if (inserted === 0) return res.redirect('/admin/questions/add?error=' + encodeURIComponent('No questions imported. ' + errors.slice(0,3).join('; ')));
      let msg = inserted + ' questions imported successfully';
      if (errors.length) msg += ' (' + errors.length + ' rows skipped)';
      res.redirect('/admin/questions/add?success=' + encodeURIComponent(msg) + (errors.length ? '&warning=' + encodeURIComponent(errors.slice(0,3).join('; ')) : ''));
    }
  } catch (e) {
    return res.redirect('/admin/questions/add?error=' + encodeURIComponent('CSV parse error: ' + e.message));
  }
});

// Delete question
app.post('/admin/questions/delete', isLoggedIn, isAdmin, (req, res) => {
  const { id } = req.body;
  db.run('DELETE FROM questions WHERE id = ?', [id], (err) => {
    if (err) return res.redirect('/admin?error=' + encodeURIComponent('Delete failed'));
    res.redirect('/admin?warning=' + encodeURIComponent('Question deleted'));
  });
});

// Create exam - with dynamic subjects + semester/period, questions filtered by subject (scoped to admin)
app.get('/admin/exams/create', isLoggedIn, isAdmin, (req, res) => {
  getAdminSubjects(req, (err, subjects) => {
    if (err) subjects = [];
    const qSc = scopeClause(req, 'created_by');
    db.all('SELECT * FROM questions WHERE 1=1' + qSc.sql + ' ORDER BY subject, created_at DESC LIMIT 100', qSc.params, (err2, questions) => {
      if (err2) return res.status(500).send('Database error');
        res.render('create_exam', { questions: questions || [], subjects: subjects || [], user: req.session });
    });
  });
});

app.post('/admin/exams/create', isLoggedIn, isAdmin, (req, res) => {
  const { title, subject, semester, period, instruction, duration, instructor, questionIds } = req.body;
  if (!title || !subject || !semester || !period) return res.redirect('/admin/exams/create?error=' + encodeURIComponent('Title, Subject, Semester and Period required'));
  const rawQ = questionIds ? (Array.isArray(questionIds) ? questionIds : [questionIds]) : [];
  const qIds = rawQ.map(v => parseInt(v, 10)).filter(n => Number.isInteger(n) && n > 0);
  if (!qIds.length) return res.redirect('/admin/exams/create?warning=' + encodeURIComponent('Select at least one valid question'));
  // Validate the selected subject belongs to this admin (super sees all) before proceeding
  const subjScope = scopeClause(req, 'created_by');
  db.get('SELECT COUNT(*) as cnt FROM subjects WHERE name = ?' + subjScope.sql, [subject].concat(subjScope.params), (errS, sRow) => {
    if (errS || !sRow || sRow.cnt === 0) return res.redirect('/admin/exams/create?error=' + encodeURIComponent('Invalid subject for your account'));
    // Verify all selected questions belong to this admin (super sees all)
    const qScope = scopeClause(req, 'created_by');
    const placeholders = qIds.map(() => '?').join(',');
    db.all('SELECT COUNT(*) as cnt FROM questions WHERE id IN (' + placeholders + ')' + qScope.sql, qIds.concat(qScope.params), (errQ, qRow) => {
      if (errQ) return res.redirect('/admin/exams/create?error=' + encodeURIComponent('Failed to validate questions'));
      if (!qRow || qRow[0].cnt !== qIds.length) return res.redirect('/admin/exams/create?error=' + encodeURIComponent('One or more selected questions are invalid or not yours'));
      db.run(
        'INSERT INTO exams (title, subject, semester, period, instruction, duration, instructor, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [title, subject, semester, period, instruction || null, duration, instructor, req.session.userId],
        function(err) {
          if (err) return res.redirect('/admin/exams/create?error=' + encodeURIComponent('Failed to create exam'));
          const examId = this.lastID;
          const stmt = db.prepare('INSERT INTO exam_questions (exam_id, question_id) VALUES (?, ?)');
          let insertedQ = 0;
          qIds.forEach((id, i) => stmt.run(examId, id, (e2) => { if (!e2) insertedQ++; if (i === qIds.length - 1) stmt.finalize(() => res.redirect('/admin?success=' + encodeURIComponent('Exam "' + title + '" created with ' + insertedQ + ' questions'))); }));
        }
      );
    });
  });
});

// ===== STUDENT ROUTES =====

// Student dashboard - list exams filtered by student's admin (referrer) + subjects, show taken + score
app.get('/student', isLoggedIn, (req, res) => {
  db.get('SELECT subjects, full_name, course, year_level, referrer_id FROM users WHERE id = ?', [req.session.userId], (err, u) => {
    let mySubjects = [];
    try { mySubjects = u && u.subjects ? JSON.parse(u.subjects) : (req.session.subjects || []); } catch(e){ mySubjects = []; }
    // Student only sees exams owned by the admin who referred them (their instructor)
    const ownerId = (u && u.referrer_id) ? u.referrer_id : 1;
    db.all('SELECT * FROM exams WHERE created_by = ? ORDER BY created_at DESC', [ownerId], (err2, allExams) => {
      if (err2) return res.status(500).send('Database error');
      db.all('SELECT exam_id, score, completed_at FROM scores WHERE student_id=?', [req.session.userId], (err3, myScores) => {
        const scoreMap = {}; const takenSet = new Set();
        (myScores||[]).forEach(s => { scoreMap[s.exam_id] = s; takenSet.add(String(s.exam_id)); });
        let filtered = allExams;
        if (mySubjects && mySubjects.length) filtered = allExams.filter(e => mySubjects.includes(e.subject));
        res.render('student_dashboard', { exams: filtered, allExams, user: req.session, mySubjects, scoreMap, takenSet });
      });
    });
  });
});

// Take exam - checks subject access and that exam belongs to student's admin
app.get('/student/exam/:examId', isLoggedIn, (req, res) => {
  const examId = req.params.examId;
  db.get(`SELECT e.*, GROUP_CONCAT(q.id || "||" || q.question || "||" || q.option_a || "||" || q.option_b || "||" || q.option_c || "||" || q.option_d || "||" || q.correct_answer, '|||') as qlist FROM exams e LEFT JOIN exam_questions eq ON e.id = eq.exam_id LEFT JOIN questions q ON eq.question_id = q.id WHERE e.id = ? GROUP BY e.id`, [examId], (err, exam) => {
    if (err) return res.status(500).send('Database error');
    if (!exam) return res.status(404).send('Exam not found');
    db.get('SELECT subjects, referrer_id FROM users WHERE id = ?', [req.session.userId], (err2, u) => {
      let mySubjects = [];
      try { mySubjects = u && u.subjects ? JSON.parse(u.subjects) : []; } catch(e){}
      const ownerId = (u && u.referrer_id) ? u.referrer_id : 1;
      if (exam.created_by && exam.created_by !== ownerId) {
        return res.status(403).send('<div style="font-family:Inter,sans-serif; max-width:600px; margin:4rem auto; text-align:center;"><h3>Access denied</h3><p>This exam does not belong to your class/teacher.</p><a href="/student" style="color:#6366f1;">Back to dashboard</a></div>');
      }
      if (mySubjects.length && !mySubjects.includes(exam.subject)) {
        return res.status(403).send('<div style="font-family:Inter,sans-serif; max-width:600px; margin:4rem auto; text-align:center;"><h3>Access denied</h3><p>You do not have subject <b>' + exam.subject + '</b>.</p><p>Your subjects: ' + mySubjects.join(', ') + '</p><a href="/student" style="color:#6366f1;">Back to dashboard</a></div>');
      }
      db.get('SELECT score FROM scores WHERE student_id=? AND exam_id=?', [req.session.userId, examId], (err3, taken) => {
        if (taken) {
          return res.status(403).send('<div style="font-family:Inter,sans-serif; max-width:600px; margin:4rem auto; text-align:center; background:white; padding:2rem; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.08);"><h3>Already Taken</h3><p>You already took <b>' + exam.title + '</b> — Score: <b>' + taken.score + '</b></p><a href="/student" style="display:inline-block; margin-top:1rem; padding:0.6rem 1rem; background:#6366f1; color:white; border-radius:8px; text-decoration:none;">Back to Dashboard</a></div>');
        }
        const qList = exam.qlist ? exam.qlist.split('|||') : [];
        const parsedQuestions = qList.map(q => {
          const parts = q.split('||');
          return { id: parts[0], question_text: parts[1], options: [parts[2], parts[3], parts[4], parts[5]], correct: parts[6] };
        }).filter(q => q.id && q.question_text);
        res.render('take_exam', { 
          examId: exam.id,
          examTitle: exam.title,
          subjectName: exam.subject,
          duration: exam.duration || 30,
          questions: parsedQuestions,
          user: req.session 
        });
      });
    });
  });
});

// Submit exam - auto-score
app.post('/student/exam/:examId/submit', isLoggedIn, (req, res) => {
  const examId = req.params.examId;
  const { answers } = req.body;

  db.all(`SELECT q.id, q.correct_answer FROM questions q JOIN exam_questions eq ON q.id = eq.question_id WHERE eq.exam_id = ?`, [examId], (err, questions) => {
    if (err) return res.status(500).json({ error: 'Database error' });

    let score = 0;
    const total = questions.length;
    questions.forEach(q => {
      const selected = answers && answers[q.id] !== undefined ? answers[q.id] : -1;
      if (String(selected) === String(q.correct_answer)) score++;
    });

    db.run(
      'INSERT INTO scores (student_id, exam_id, score) VALUES (?, ?, ?)',
      [req.session.userId, examId, score],
      (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ redirect: `/student/exam/${examId}/result` });
      }
    );
  });
});

// View exam result after submission
app.get('/student/exam/:examId/result', isLoggedIn, (req, res) => {
  const examId = req.params.examId;
  db.get('SELECT title FROM exams WHERE id=?', [examId], (err, examRow) => {
    if (err) return res.status(500).send('Database error');
    const examTitle = examRow ? examRow.title : 'Exam';
    db.get('SELECT score FROM scores WHERE student_id=? AND exam_id=? ORDER BY id DESC LIMIT 1', [req.session.userId, examId], (err2, scoreRow) => {
      if (err2) return res.status(500).send('Database error');
      db.all(`SELECT q.id, q.correct_answer FROM questions q JOIN exam_questions eq ON q.id = eq.question_id WHERE eq.exam_id = ?`, [examId], (err3, questions) => {
        if (err3) return res.status(500).send('Database error');
        const total = questions.length;
        const score = scoreRow ? scoreRow.score : 0;
        const percentage = total ? Math.round(score/total*100) : 0;
        res.render('exam_result', { score, total, percentage, examTitle, examId, user: req.session });
      });
    });
  });
});

// View scores (admin) - with search & pagination 10 (scoped to admin's exams)
app.get('/admin/scores', isLoggedIn, isAdmin, (req, res) => {
  const search = (req.query.search || '').trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 10;
  const offset = (page - 1) * limit;
  const like = '%' + search + '%';
  const eSc = scopeClause(req, 'created_by', 'e');
  const baseWhere = ' WHERE 1=1' + eSc.sql;
  const searchWhere = search ? ' AND (u.full_name LIKE ? OR u.username LIKE ? OR u.course LIKE ? OR u.year_level LIKE ? OR u.set_group LIKE ? OR e.title LIKE ? OR e.subject LIKE ? OR e.semester LIKE ? OR e.period LIKE ? OR s.score LIKE ?)' : '';
  const searchParams = search ? [like,like,like,like,like,like,like,like,like,like] : [];
  const where = baseWhere + searchWhere;
  const params = eSc.params.concat(searchParams);
  db.get('SELECT COUNT(*) as cnt FROM scores s JOIN users u ON s.student_id = u.id JOIN exams e ON s.exam_id = e.id ' + where, params, (err, cntRow) => {
    const total = cntRow ? cntRow.cnt : 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const query = 'SELECT s.id as score_id, s.score, s.completed_at, s.exam_id, s.student_id, u.username, u.full_name, u.course, u.year_level, u.set_group, e.title as exam_title, e.subject, e.semester, e.period FROM scores s JOIN users u ON s.student_id = u.id JOIN exams e ON s.exam_id = e.id ' + where + ' ORDER BY s.completed_at DESC LIMIT ? OFFSET ?';
    const qParams = params.concat([limit, offset]);
    db.all(query, qParams, (err2, scores) => {
      if (err2) return res.status(500).send('Database error');
      res.render('scores', { scores, search, page, totalPages, total, user: req.session });
    });
  });
});

app.post('/admin/scores/delete', isLoggedIn, isAdmin, (req, res) => {
  const { id } = req.body;
  const eSc = scopeClause(req, 'created_by', 'e');
  db.get('SELECT s.student_id, s.exam_id FROM scores s JOIN exams e ON s.exam_id = e.id WHERE s.id = ?' + eSc.sql, [id].concat(eSc.params), (err, row) => {
    if (err || !row) return res.redirect('/admin/scores?error=' + encodeURIComponent('Record not found or not yours'));
    db.run('DELETE FROM scores WHERE id=?', [id], (err2) => {
      if (err2) return res.redirect('/admin/scores?error=' + encodeURIComponent('Delete failed'));
      res.redirect('/admin/scores?success=' + encodeURIComponent('Record deleted — student can retake that exam now') + '&warning=' + encodeURIComponent('Deleted score for exam ' + row.exam_id));
    });
  });
});

// Scores printed report — all students who took exams (scoped to admin), grouped by SET and Year
app.get('/admin/scores/report', isLoggedIn, isAdmin, (req, res) => {
  const eSc = scopeClause(req, 'created_by', 'e');
  db.all(`SELECT s.id as score_id, s.score, s.completed_at, s.student_id,
                 u.username, u.full_name, u.course, u.year_level, u.set_group,
                 e.id as exam_id, e.title as exam_title, e.subject, e.semester, e.period
          FROM scores s
          JOIN users u ON s.student_id = u.id
          JOIN exams e ON s.exam_id = e.id
          WHERE 1=1` + eSc.sql + `
          ORDER BY e.title ASC, u.set_group ASC, u.year_level ASC, u.full_name ASC`, eSc.params, (err, rows) => {
    if (err) return res.status(500).send('Report generation failed. Please try again.');
    if (!rows || rows.length === 0) return res.render('scores_report', { report: [], examsCount: 0, totalStudents: 0, overallAvg: 0, generatedAt: new Date(), user: req.session });

    // Count questions per exam for percentages
    db.all('SELECT exam_id, COUNT(*) as cnt FROM exam_questions GROUP BY exam_id', [], (err2, qCounts) => {
      const qMap = {};
      (qCounts || []).forEach(q => { qMap[q.exam_id] = q.cnt; });

      // Group: exam -> set (letter) -> year -> students
      const examsByKey = new Map();
      rows.forEach(r => {
        const key = String(r.exam_id);
        if (!examsByKey.has(key)) {
          examsByKey.set(key, {
            exam_id: r.exam_id,
            title: r.exam_title,
            subject: r.subject,
            semester: r.semester,
            period: r.period,
            sets: new Map()
          });
        }
        const exam = examsByKey.get(key);
        const setKey = (r.set_group && r.set_group.trim()) ? r.set_group.trim().toUpperCase() : 'No Set';
        if (!exam.sets.has(setKey)) exam.sets.set(setKey, new Map());
        const years = exam.sets.get(setKey);
        const yearKey = (r.year_level && r.year_level.trim()) ? r.year_level.trim() : 'No Year';
        if (!years.has(yearKey)) years.set(yearKey, []);
        years.get(yearKey).push({
          full_name: r.full_name || r.username,
          username: r.username,
          course: r.course || '—',
          score: r.score,
          completed_at: r.completed_at
        });
      });

      const toLocale = (v, fallback) => (v && String(v).trim()) ? String(v).trim() : fallback;

      const report = [];
      let totalStudents = 0;
      let scoreSum = 0;
      const examOrder = [...examsByKey.keys()].sort((a, b) => String(examsByKey.get(a).title).localeCompare(String(examsByKey.get(b).title)));

      examOrder.forEach(key => {
        const exam = examsByKey.get(key);
        const questionCount = qMap[exam.exam_id] || 0;
        const sets = [...exam.sets.keys()].sort((a, b) => (a === 'No Set' ? 1 : 0) - (b === 'No Set' ? 1 : 0) || a.localeCompare(b));
        const examSets = sets.map(setKey => {
          const yearsMap = exam.sets.get(setKey);
          const years = [...yearsMap.keys()].sort((a, b) => (a === 'No Year' ? 1 : 0) - (b === 'No Year' ? 1 : 0) || a.localeCompare(b, undefined, { numeric: true }));
          return {
            set: setKey,
            years: years.map(yearKey => {
              const students = yearsMap.get(yearKey).sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
              const sum = students.reduce((s, st) => s + st.score, 0);
              students.forEach(st => { st.percent = questionCount ? Math.round(st.score / questionCount * 100) : 0; });
              return {
                year: yearKey,
                students,
                count: students.length,
                sum,
                avg: students.length ? Math.round(sum / students.length * 10) / 10 : 0
              };
            })
          };
        });

        const examStudents = rows.filter(r => String(r.exam_id) === key);
        exam.studentsCount = examStudents.length;
        exam.setsArray = examSets;
        exam.questionCount = questionCount;
        exam.avgScore = examStudents.length ? Math.round(examStudents.reduce((s, r) => s + r.score, 0) / examStudents.length * 10) / 10 : 0;
        exam.avgPercent = questionCount ? Math.round(exam.avgScore / questionCount * 100) : 0;
        totalStudents += examStudents.length;
        scoreSum += examStudents.reduce((s, r) => s + r.score, 0);
        report.push(exam);
      });

      res.render('scores_report', {
        report,
        examsCount: report.length,
        totalStudents,
        overallAvg: totalStudents ? Math.round(scoreSum / totalStudents * 10) / 10 : 0,
        generatedAt: new Date(),
        user: req.session
      });
    });
  });
});

// Also when deleting a user who has taken exams, delete their scores so they can retake (if recreated)
app.post('/admin/users/delete', isLoggedIn, isAdmin, (req, res) => {
  const { id } = req.body;
  if (String(id) === String(req.session.userId)) return res.redirect('/admin/users?error=' + encodeURIComponent('Cannot delete yourself'));
  db.run('DELETE FROM scores WHERE student_id=?', [id], () => {
    db.run('DELETE FROM users WHERE id=?', [id], (err) => {
      if (err) return res.redirect('/admin/users?error=' + encodeURIComponent('Delete failed'));
      res.redirect('/admin/users?warning=' + encodeURIComponent('User and their exam records deleted — they can signup and retake'));
    });
  });
});

// ===== SETTINGS - DYNAMIC SUBJECTS / SCHEDULE (scoped to admin) =====
app.get('/admin/settings', isLoggedIn, isAdmin, (req, res) => {
  const s = scopeClause(req, 'created_by');
  db.all('SELECT * FROM subjects WHERE 1=1' + s.sql + ' ORDER BY schedule ASC, name ASC', s.params, (err, subjects) => {
    if (err) return res.status(500).send('Database error');
    res.render('settings', { subjects: subjects || [], user: req.session });
  });
});

app.post('/admin/settings/add', isLoggedIn, isAdmin, (req, res) => {
  const { name, code, schedule } = req.body;
  if (!name || !name.trim()) return res.redirect('/admin/settings?error=' + encodeURIComponent('Name of Subject is required'));
  db.run('INSERT INTO subjects (name, code, schedule, created_by) VALUES (?, ?, ?, ?)', [name.trim(), (code || '').trim() || null, schedule || null, req.session.userId], (err) => {
    if (err) return res.redirect('/admin/settings?error=' + encodeURIComponent('Subject already exists (name must be unique system-wide)'));
    res.redirect('/admin/settings?success=' + encodeURIComponent('Subject "' + name.trim() + '" added successfully'));
  });
});

app.post('/admin/settings/delete', isLoggedIn, isAdmin, (req, res) => {
  const { id } = req.body;
  const s = scopeClause(req, 'created_by');
  db.run('DELETE FROM subjects WHERE id = ?' + s.sql, [id].concat(s.params), (err) => {
    if (err) return res.redirect('/admin/settings?error=' + encodeURIComponent('Delete failed'));
    res.redirect('/admin/settings?warning=' + encodeURIComponent('Subject deleted'));
  });
});

app.post('/admin/settings/update', isLoggedIn, isAdmin, (req, res) => {
  const { id, name, code, schedule } = req.body;
  const s = scopeClause(req, 'created_by');
  db.run('UPDATE subjects SET name = ?, code = ?, schedule = ? WHERE id = ?' + s.sql, [name.trim(), (code || '').trim() || null, schedule || null, id].concat(s.params), (err) => {
    if (err) return res.redirect('/admin/settings?error=' + encodeURIComponent('Update failed'));
    res.redirect('/admin/settings?success=' + encodeURIComponent('Subject updated'));
  });
});

// ===== USERS MANAGEMENT =====
app.get('/admin/users', isLoggedIn, isAdmin, (req, res) => {
  const search = (req.query.search || '').trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 10;
  const offset = (page - 1) * limit;
  const like = '%' + search + '%';
  const superAdmin = isSuperAdmin(req);
  // Sub-admin only sees their own students; super sees everyone.
  const ownerScope = superAdmin ? { sql: '', params: [] }
                               : { sql: " AND role='student' AND referrer_id = ? ", params: [req.session.userId] };
  const searchWhere = search ? ' AND (full_name LIKE ? OR username LIKE ? OR course LIKE ? OR year_level LIKE ? OR set_group LIKE ? OR subjects LIKE ? OR role LIKE ?)' : '';
  const searchParams = search ? [like, like, like, like, like, like, like] : [];
  const where = ' WHERE 1=1' + ownerScope.sql + searchWhere;
  const params = ownerScope.params.concat(searchParams);
  db.get('SELECT COUNT(*) as cnt FROM users ' + where, params, (err, cntRow) => {
    const total = cntRow ? cntRow.cnt : 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const query = 'SELECT id, username, full_name, course, year_level, set_group, subjects, role, referrer_id, is_locked, failed_attempts, created_at FROM users ' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const qParams = params.concat([limit, offset]);
    db.all(query, qParams, (err2, users) => {
      if (err2) return res.status(500).send('Database error');
      getAdminSubjects(req, (err3, subjects) => {
        // For super: also list all admin accounts for management.
        db.all("SELECT id, username, full_name, signup_token, created_at FROM users WHERE role='admin' ORDER BY created_at ASC", [], (err4, admins) => {
          db.get('SELECT signup_token FROM users WHERE id=?', [req.session.userId], (err5, meRow) => {
            const myToken = meRow ? meRow.signup_token : null;
            const signupLink = myToken ? (req.protocol + '://' + req.get('host') + '/signup?ref=' + myToken) : null;
            res.render('admin_users', { users: users || [], admins: admins || [], subjects: subjects || [], search, page, totalPages, total, user: req.session, superAdmin, signupLink });
          });
        });
      });
    });
  });
});

// Create a new admin account (super admin only)
app.post('/admin/users/create-admin', isLoggedIn, isAdmin, (req, res) => {
  if (!isSuperAdmin(req)) return res.redirect('/admin/users?error=' + encodeURIComponent('Only the main admin can create admin accounts'));
  const { username, password, full_name } = req.body;
  if (!username || !username.trim() || !password) return res.redirect('/admin/users?error=' + encodeURIComponent('Username and password required'));
  const token = require('crypto').randomBytes(12).toString('hex');
  db.run('INSERT INTO users (username, password, full_name, role, signup_token, is_super) VALUES (?, ?, ?, "admin", ?, 0)',
    [username.trim(), password, (full_name||'').trim() || username.trim(), token],
    (err) => {
      if (err) return res.redirect('/admin/users?error=' + encodeURIComponent('Username already exists'));
      res.redirect('/admin/users?success=' + encodeURIComponent('Admin account "' + username.trim() + '" created — they can log in and manage their own subjects/exams/students'));
    });
});

// Endpoint to view any admin's signup link (super only) — returns plain text link
app.post('/admin/users/signup-link', isLoggedIn, isAdmin, (req, res) => {
  if (!isSuperAdmin(req)) return res.redirect('/admin/users?error=' + encodeURIComponent('Super admin only'));
  const { id } = req.body;
  db.get('SELECT username, signup_token FROM users WHERE id=? AND role="admin"', [id], (err, a) => {
    if (err || !a) return res.redirect('/admin/users?error=' + encodeURIComponent('Admin not found'));
    const link = req.protocol + '://' + req.get('host') + '/signup?ref=' + a.signup_token;
    return res.redirect('/admin/users?success=' + encodeURIComponent('Signup link for ' + a.username + ': ' + link));
  });
});

app.post('/admin/users/update', isLoggedIn, isAdmin, (req, res) => {
  const { id, full_name, course, year_level, set_group, username, role } = req.body;
  let subs = req.body.subjects;
  if (!subs) subs = [];
  else if (!Array.isArray(subs)) subs = [subs];
  const subjectsJson = JSON.stringify(subs);
  db.run('UPDATE users SET full_name=?, course=?, year_level=?, set_group=?, username=?, role=?, subjects=? WHERE id=?', [full_name.trim(), course.trim(), year_level, set_group, username.trim(), role, subjectsJson, id], (err) => {
    if (err) return res.redirect('/admin/users?error=' + encodeURIComponent('Update failed: username may exist'));
    res.redirect('/admin/users?success=' + encodeURIComponent('User updated'));
  });
});

app.post('/admin/users/reset-password', isLoggedIn, isAdmin, (req, res) => {
  const { id, temp_password } = req.body;
  let temp = (temp_password || '').trim();
  if (!temp) temp = 'Temp' + Math.floor(1000 + Math.random() * 9000) + '!';
  db.run('UPDATE users SET password=?, is_locked=0, failed_attempts=0 WHERE id=?', [temp, id], (err) => {
    if (err) return res.redirect('/admin/users?error=' + encodeURIComponent('Reset failed'));
    db.get('SELECT username FROM users WHERE id=?', [id], (err2, u) => {
      const msg = 'Password for ' + (u ? u.username : 'user') + ' reset to: ' + temp + ' (unlocked)';
      res.redirect('/admin/users?success=' + encodeURIComponent(msg) + '&warning=' + encodeURIComponent('Give this temp password to user to login and change it'));
    });
  });
});

app.post('/admin/users/unlock', isLoggedIn, isAdmin, (req, res) => {
  const { id } = req.body;
  db.run('UPDATE users SET is_locked=0, failed_attempts=0 WHERE id=?', [id], (err) => {
    if (err) return res.redirect('/admin/users?error=' + encodeURIComponent('Unlock failed'));
    res.redirect('/admin/users?success=' + encodeURIComponent('Account unlocked — user can login again'));
  });
});

// Change password for any logged-in user (after temp login)
app.get('/change-password', isLoggedIn, (req, res) => {
  res.render('change_password', { user: req.session });
});
app.post('/change-password', isLoggedIn, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (!new_password || new_password !== confirm_password) return res.redirect('/change-password?error=' + encodeURIComponent('New passwords do not match'));
  db.get('SELECT password FROM users WHERE id=?', [req.session.userId], (err, row) => {
    if (err || !row) return res.redirect('/change-password?error=' + encodeURIComponent('User not found'));
    if (row.password !== current_password) return res.redirect('/change-password?error=' + encodeURIComponent('Current password incorrect'));
    db.run('UPDATE users SET password=? WHERE id=?', [new_password, req.session.userId], (err2) => {
      if (err2) return res.redirect('/change-password?error=' + encodeURIComponent('Update failed'));
      res.redirect((req.session.role === 'admin' ? '/admin' : '/student') + '?success=' + encodeURIComponent('Password changed successfully'));
    });
  });
});

// Get LAN IP for the startup banner
const os = require('os');

// ===== START SERVER =====
function getLanAddress() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch (e) {}
  return null;
}

app.listen(PORT, () => {
  const lan = getLanAddress();
  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log('  🎓  ONLINE EXAM SYSTEM — SERVER ONLINE');
  console.log(line);
  console.log('  ✓ Status      : Running');
  console.log('  ✓ Local URL   : http://localhost:' + PORT);
  if (lan) console.log('  ✓ Network URL : http://' + lan + ':' + PORT);
  console.log('  ✓ Environment : ' + (process.env.NODE_ENV || 'development'));
  console.log('  ✓ Started at  : ' + new Date().toLocaleString());
  console.log(line + '\n');
});