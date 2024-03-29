const fs = require('fs');
const path = require("path");
const crypto = require("crypto");

function getCardImage(images){
    let image = null;
    if (images?.["png"]){
        image = images["png"];
    } else if (images?.["large"]){
        image = images["large"];
    } else if (images?.["normal"]){
        image = images["normal"];
    } else if (images?.["small"]){
        image = images["small"];
    } else if (images?.["border_crop"]){
        image = images["border_crop"];
    } else {
        image = images?.[Object.keys(images)?.[0]] ?? null;
    }
    return image;
}

function getArtCrop(images){
    let image = null;
    if (images?.["art_crop"]){
        image = images["art_crop"];
    }
    return image;
}

function buildCardData(data){
    const card = {
        name: data["name"],
        layout: data["layout"],
        colors: data?.["colors"] || data?.["color_identity"] || [],
        legalities: data?.["legalities"] ?? [],
        rarity: data?.["rarity"] ?? null,
        keywords: data?.["keywords"] ?? [],
        front: null,
        back: null,
        type: null,
        subtypes: [],
        texts: [],
        manaCosts: [],
        totalManaCost: 0,
        faceNames: [],
        flavorTexts: [],
        toughness: 0,
        power: 0,
        art: null,
    };

    for (const legalitie in card.legalities){
        if (card.legalities[legalitie] === "legal"){
            card.legalities[legalitie] = true;
        } else {
            card.legalities[legalitie] = false;
        }
    }

    if (data?.["card_faces"]?.length){
        for (let i = 0; i < data["card_faces"].length; i++){
            if ("type_line" in data["card_faces"][i]){
                const types = data["card_faces"][i]?.["type_line"]?.split("—") ?? [];
                if (types.length){
                    if (!card.type){
                        card.type = types[0].trim();
                    }
                    for (let i = 1; i < types.length; i++){
                        card.subtypes.push(types[i].trim());
                    }
                }
            }
            if (data["card_faces"][i]?.["oracle_text"]){
                card.texts.push(data["card_faces"][i]["oracle_text"]);
            }
            if (data["card_faces"][i]?.["mana_cost"]){
                card.manaCosts.push(data["card_faces"][i]["mana_cost"]);
                if (i === 0){
                    const manaValues = data["card_faces"][i]["mana_cost"].match(/\d|R|U|B|G|W|S/g);
                    if (manaValues){
                        for (let i = 0; i < manaValues.length; i++){
                            const value = parseInt(manaValues[i]);
                            if (!isNaN(value)){
                                card.totalManaCost += value;
                            } else {
                                card.totalManaCost += 1;
                            }
                        }
                    }
                }
            }
            if (data["card_faces"][i]?.["name"]){
                card.faceNames.push(data["card_faces"][i]["name"]);
            }
            if (data["card_faces"][i]?.["flavor_text"]){
                card.flavorTexts.push(data["card_faces"][i]["flavor_text"]);
            }
            if (data["card_faces"][i]?.["toughness"] && data["card_faces"][i]?.["power"]){
                card.power = data["card_faces"][0]["power"];
                card.toughness = data["card_faces"][0]["toughness"];
            }
        }
        if (["modal_dfc", "transform"].includes(data["layout"])){
            card.front = getCardImage(data["card_faces"][0]?.["image_uris"] ?? {});
            card.back = getCardImage(data["card_faces"][1]?.["image_uris"] ?? {});
            card.art = getArtCrop(data["card_faces"][0]?.["image_uris"] ?? {});
        } else {
            card.front = getCardImage(data?.["image_uris"] ?? {});
            card.back = getCardImage(data?.["image_uris"] ?? {});
            card.art = getArtCrop(data?.["image_uris"] ?? {});
        }
    } else {
        card.front = getCardImage(data?.["image_uris"] ?? {});
        card.art = getArtCrop(data?.["image_uris"] ?? {});
        if (data?.["oracle_text"]){
            card.texts.push(data["oracle_text"]);
        }
        if (data?.["mana_cost"]){
            card.manaCosts.push(data["mana_cost"]);
        }
        if (data?.["name"]){
            card.faceNames.push(data["name"]);
        }
        if (data?.["flavor_text"]){
            card.flavorTexts.push(data["flavor_text"]);
        }
        if (data?.["power"] && data?.["toughness"]){
            card.power = data["power"];
            card.toughness = data["toughness"];
        }
        const types = data?.["type_line"]?.split("—") ?? [];
        if (types.length){
            card.type = types[0].trim();
            for (let i = 1; i < types.length; i++){
                card.subtypes.push(types[i].trim());
            }
        }
        const manaValues = data["mana_cost"].match(/\d|R|U|B|G|W|S/g);
        if (manaValues){
            for (let i = 0; i < manaValues.length; i++){
                const value = parseInt(manaValues[i]);
                if (!isNaN(value)){
                    card.totalManaCost += value;
                } else {
                    card.totalManaCost += 1;
                }
            }
        }
    }
    return card;
}

module.exports = async (scryfallData, outDir, count) => {    

    console.log(`Processing card #${count}: ${scryfallData.name}`);

    let card = buildCardData(scryfallData);

    if (!card.front){
        return;
    }

    const cleanName = card.name.trim().toLowerCase().replace(/[^a-z0-9-_\s]/gi, "").replace(/\s+/g, " ");
    const hash = crypto.createHash("md5").update(cleanName).digest("hex");
    if (!fs.existsSync(path.join(outDir, hash))){
        await fs.promises.mkdir(path.join(outDir, hash));
    }

    const cardFile = path.join(outDir, hash, "card.json");
    if (fs.existsSync(cardFile)){
        await fs.promises.unlink(cardFile);
    }

    card.dir = path.join(outDir, hash);
    card.id = hash;

    await fs.promises.writeFile(cardFile, JSON.stringify(card));

    return;
}
