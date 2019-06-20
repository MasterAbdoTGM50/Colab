import express from "express";
import { getRepository } from "typeorm";
import { requireToken} from "./auth";
import { Privacy, Session} from "../types/session";
import fs from "fs";
import path from "path";
import { Membership, Role } from "../types/membership";
import { User } from "../types/user";
import { Task } from "../types/task";
import { Grade } from "../types/grade";
import { createNamespace } from "./sockets";

let router = express.Router();

router.get("/", requireToken, async (req, res) => {
    let sessionRepo = getRepository(Session);
    let sessions = await sessionRepo.find({ select: ["id", "sname", "description"], where: { hidden: false } });

    res.status(200).json({ sessions: sessions });
});

router.get("/joined", requireToken, async (req, res) => {
    let userRepo = getRepository(User);
    let user = await userRepo.findOne(req["token"].username, { relations: ["memberships", "memberships.session"] });
    let sessions = user.memberships.filter(mship => mship.role !== Role.PENDING && mship.role != null).map(mship => {
        return {
            id: mship.session.id,
            sname: mship.session.sname,
            description: mship.session.description,
            role: mship.role
        }
    });
    for(let i = 0; i < sessions.length; ++i) { sessions[i]["owner"] = await getSessionOwner(sessions[i]["id"]); }
    res.status(200).json({ sessions: sessions });
});

router.get("/invited", requireToken, async (req, res) => {
    let userRepo = getRepository(User);
    let user = await userRepo.findOne(req["token"].username, { relations: ["memberships", "memberships.session", "memberships.user"] });
    let sessions = user.memberships.filter(mship => mship.role === Role.PENDING && mship.role != null).map(async (mship) => {
        return {
            id: mship.session.id,
            sname: mship.session.sname,
            description: mship.session.description
        }
    });
    for(let i = 0; i < sessions.length; ++i) { sessions[i]["owner"] = await getSessionOwner(sessions[i]["id"]); }
    res.status(200).json({ sessions: sessions });
});

router.post("/invite",  requireToken, async (req, res) => {
    let user = await getRepository(User).findOne(req.body.username);
    let session = await getRepository(Session).findOne(req.body.session, { relations: ["memberships, memberships.user, memberships.session"]});

    if(!user) { return res.status(400).json({ "error": "User doesn't exist"} ); }
    if(!session) { return res.status(400).json({ "error": "Session doesn't exist"} ); }

    if(session.memberships.filter(
        mship => (
            mship.role == Role.OWNER &&
            mship.user.username == req["token"].username) &&
            mship.session.id == req.body.session
    ).length != 0) {
        let membership = new Membership();
        membership.user = user;
        membership.session = session;
        membership.role = Role.PENDING;
        await getRepository(Membership).save(membership);

        res.sendStatus(200);
    } else {
        res.status(403).json({ "error": "You are not authorized for invitation"} );
    }
});

router.get("/join/:sessionId",  requireToken, async (req, res) => {
    let session = await getRepository(Session).findOne(req.params.sessionId, {relations: ["memberships", "memberships.user", "memberships.session"] });
    let membershipRepo = getRepository(Membership);
    let membership = null;

    if(!session) { return res.status(400).json({ "error": "Session doesn't exist"}); }

    for(let i = 0; i < session.memberships.length; ++i) {
        if(session.memberships[i].user.username == req["token"].username) {
            membership = session.memberships[i];
            break;
        }
    }

    switch (session.privacy) {
        case Privacy.PUBLIC:
        case Privacy.HIDDEN:
            if(!membership) {
                membership = new Membership();
                membership.session = session;
                membership.user = req["token"].username;
                membership.role = Role.GHOST;
                await membershipRepo.save(membership);
            }
            res.sendStatus(200);
            break;
        case Privacy.PRIVATE:
            if(!membership) { return res.status(403).json({ "error": "Not invited to this session" }); } else {
                if(membership.role == Role.PENDING) {
                    membership.role = Role.GHOST;
                    await membershipRepo.save(membership);
                }
                res.sendStatus(200);
            }
            break;
    }
    createUserFiles(session.id, req["token"].username);
    createNamespace("/" + session.id);
});

router.post("/create-session", requireToken, async (req, res) => {
    if(!req.body.session) { return res.status(400).json({ "error": "Missing namespace object" }); }
    if(!req.body.session.sname) { return res.status(400).json({ "error": "Missing sname field" }); }
    let session = new Session(req.body.session.sname);

    if(req.body.session.privacy) { session.privacy = req.body.session.privacy; }
    if(req.body.session.description) { session.description = req.body.session.description; }

    let sessionRepo = getRepository(Session);
    session = await sessionRepo.save(session);

    let membershipRepo = getRepository(Membership);

    let membership = new Membership();
    membership.session = await sessionRepo.findOne(session.id);

    let userRepo = getRepository(User);
    membership.user = await userRepo.findOne(req["token"].username);

    membership.role = Role.OWNER;

    await membershipRepo.save(membership);

    fs.mkdirSync(path.join(__dirname, "../../sessions/" + session.id + "/data"), { recursive: true });
    createUserFiles(session.id, req["token"].username);

    res.status(200).json({ session: { id: session.id }});
});

router.post("/create-task", requireToken, async (req, res) => {
    if(!req.body.sessionId) { return res.status(400).json({ "error": "Missing sessionId field" }); }
    if(!req.body.task) { return res.status(400).json({ "error": "Missing task object" }); }
    if(!req.body.task.cases) { return res.status(400).json({ "error": "Missing cases array in task object" }); }

    let session = await getRepository(Session).findOne(req.params.sessionId, {relations: ["tasks", "memberships", "memberships.user", "memberships.session"] });

    if(!session) { return res.status(400).json({ "error": "Session doesn't exist"}) }

    let membership = null;
    for(let i = 0; i < session.memberships.length; ++i) {
        if(session.memberships[i].user.username == req["token"].username && session.memberships[i].role == Role.OWNER) {
            membership = session.memberships[i];
            break;
        }
    }

    if(!membership) { return res.status(403).json({ "error": "You are not authorized to add tasks to this session"}); }

    let task = new Task();
    task.session = session;
    task.id = session.tasks.length + 1;
    if(req.body.task.name) { task.name = req.body.task.name; }
    if(req.body.task.description) { task.name = req.body.task.description; }
    if(req.body.task.hints) { task.hints = req.body.task.hints; } else { task.hints = []; }

    task = await getRepository(Task).save(task);
    writeTest(session.id, task.id, req.body.task.cases);
    res.sendStatus(200);
});

router.post("/:sessionId/set-permission",  requireToken, async (req, res) => {
    let session = await getRepository(Session).findOne(req.body.sessionId, {relations: ["memberships", "memberships.user", "memberships.session"] });
    let user = await getRepository(User).findOne(req.body.username);

    if(!session) { return res.status(400).json({ "error": "Session doesn't exist"}); }
    if(!user) { return res.status(400).json({ "error": "User doesn't exist"}); }
    if(!req.body.role) { return res.status(400).json({ "error": "Missing role field"}); }
    if(await getSessionOwner(session) != req["token"].username) { return res.status(403).json({ "error": "You aren't allowed to set permissions"}); }

    let membership = new Membership();
    membership.session = session;
    membership.user = user;
    membership.role = req.body.role;
    await getRepository(Membership).save(membership);

    res.sendStatus(200);
});

router.get("/:sessionId/grades",  requireToken, async (req, res) => {
    let session = await getRepository(Session).findOne(req.params.sessionId, {relations: ["memberships", "memberships.user", "memberships.session"] });
    let gradesRepo = getRepository(Grade);

    if(!session) { return res.status(400).json({ "error": "Session doesn't exist"}); }

    let findOptions = { where: {}, relations: ["user", "task"] };
    if(req.query.username) { findOptions.where["user"] = req.query.username; }
    if(req.query.task) { findOptions.where["task"] = req.query.task; }

    let grades = (await gradesRepo.find(findOptions)).map(grade => {
        return {
            user: grade.user.username,
            task: grade.task,
            correct: grade.correct,
            wrong: grade.wrong
        }
    });

    res.status(200).json({ grades: grades });
});

async function getSessionOwner(sessionId) {
    let session = await getRepository(Session).findOne(sessionId, { relations: ["memberships", "memberships.user"] });
    return session.memberships.filter(mship => mship.role === Role.OWNER)[0].user.username;
}

function createUserFiles(sessionId: string, username: string) {
    if(!fs.existsSync(path.join(__dirname, "../../sessions/" + sessionId + "/data/" + username))) {
        fs.mkdirSync(path.join(__dirname, "../../sessions/" + sessionId + "/data/" + username), { recursive: true });
        fs.writeFileSync(path.join(__dirname, "../../sessions/" + sessionId + "/data/" + username + "/main.cpp"), "");
        fs.writeFileSync(path.join(__dirname, "../../sessions/" + sessionId + "/data/" + username + "/compile_commands.json"), JSON.stringify([
            {
                directory: path.join(__dirname, "../../sessions/" + sessionId + "/data/" + username),
                command: "clang++ --target=x86_64-w64-mingw32 -o main.exe main.cpp",
                file: "main.cpp"
            }
        ], null, 4))
    }
}

function writeTest(sessionId: string, taskId: number, cases) {
    fs.mkdirSync(path.join(__dirname, "../../sessions/" + sessionId + "/tasks"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "../../sessions/" + sessionId + "/tasks/task" + taskId + ".json"), JSON.stringify({
        cases: cases
    }, null, 4));
}

export { router }